const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { requireAdminAuth } = require("../middleware/auth");
const { buildCampaignMessage, sendWhatsappMessage } = require("../services/whatsappService");

const router = express.Router();
router.use(requireAdminAuth);

// POST /api/whatsapp/preview — generate a personalized message per creator without sending
const previewSchema = z.object({
  campaignId: z.string(),
  creatorIds: z.array(z.string()).min(1),
  timeline: z.string().optional(),
});

router.post("/preview", async (req, res, next) => {
  try {
    const { campaignId, creatorIds, timeline } = previewSchema.parse(req.body);
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const creators = await prisma.creator.findMany({ where: { id: { in: creatorIds } } });

    const previews = creators.map((creator) => ({
      creatorId: creator.id,
      creatorName: creator.fullName,
      whatsappNumber: creator.whatsappNumber,
      message: buildCampaignMessage({
        creatorName: creator.fullName,
        brandName: campaign.brandName,
        product: campaign.product,
        timeline: timeline || (campaign.deadline ? new Date(campaign.deadline).toDateString() : undefined),
        deliverables: campaign.deliverables,
      }),
    }));

    res.json({ previews });
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/send — send individually or in bulk, with optional
// per-creator message overrides (admin may have edited the preview)
const sendSchema = z.object({
  campaignId: z.string(),
  messages: z
    .array(
      z.object({
        creatorId: z.string(),
        messageText: z.string().min(1),
      })
    )
    .min(1),
});

router.post("/send", async (req, res, next) => {
  try {
    const { campaignId, messages } = sendSchema.parse(req.body);

    const creators = await prisma.creator.findMany({
      where: { id: { in: messages.map((m) => m.creatorId) } },
    });
    const creatorById = Object.fromEntries(creators.map((c) => [c.id, c]));

    const results = [];
    for (const m of messages) {
      const creator = creatorById[m.creatorId];
      if (!creator) {
        results.push({ creatorId: m.creatorId, error: "Creator not found" });
        continue;
      }

      let sendResult;
      try {
        sendResult = await sendWhatsappMessage({ toNumber: creator.whatsappNumber, messageText: m.messageText });
      } catch (sendErr) {
        const failed = await prisma.whatsappMessage.create({
          data: {
            creatorId: creator.id,
            campaignId,
            messageText: m.messageText,
            status: "FAILED",
            sentById: req.admin.id,
          },
        });
        results.push({ creatorId: creator.id, status: "FAILED", error: sendErr.message, id: failed.id });
        continue;
      }

      const record = await prisma.whatsappMessage.create({
        data: {
          creatorId: creator.id,
          campaignId,
          messageText: m.messageText,
          status: sendResult.status,
          providerMessageId: sendResult.providerMessageId,
          sentById: req.admin.id,
          sentAt: sendResult.sentAt,
        },
      });

      await prisma.campaignCreator
        .update({
          where: { campaignId_creatorId: { campaignId, creatorId: creator.id } },
          data: { status: "INVITED" },
        })
        .catch(() => {}); // ok if creator wasn't shortlisted on this campaign yet

      results.push({ creatorId: creator.id, status: record.status, id: record.id });
    }

    // If any messages went out, move the campaign to INVITATION_SENT.
    if (results.some((r) => r.status === "SENT")) {
      await prisma.campaign.update({ where: { id: campaignId }, data: { stage: "INVITATION_SENT" } });
    }

    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// GET /api/whatsapp/campaign/:campaignId — communication log for a campaign
router.get("/campaign/:campaignId", async (req, res, next) => {
  try {
    const messages = await prisma.whatsappMessage.findMany({
      where: { campaignId: req.params.campaignId },
      include: { creator: { select: { fullName: true, instagramUsername: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(messages);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/whatsapp/:id/status — update status from webhook/manual check
// (delivered / read / replied / accepted / declined)
const statusSchema = z.object({
  status: z.enum(["QUEUED", "SENT", "DELIVERED", "READ", "REPLIED", "ACCEPTED", "DECLINED", "FAILED", "PENDING"]),
});

router.patch("/:id/status", async (req, res, next) => {
  try {
    const { status } = statusSchema.parse(req.body);
    const timestampField =
      { DELIVERED: "deliveredAt", READ: "readAt", REPLIED: "repliedAt" }[status] || null;

    const message = await prisma.whatsappMessage.update({
      where: { id: req.params.id },
      data: { status, ...(timestampField && { [timestampField]: new Date() }) },
    });
    res.json(message);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Webhook receiver for the real WhatsApp Business API (delivery/read
// receipts + inbound replies). Wire this URL into your Meta App's
// WhatsApp > Configuration > Webhook settings once USE_MOCK_WHATSAPP=false.
// ---------------------------------------------------------------------
router.post("/webhook", async (req, res, next) => {
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    const statuses = entry?.statuses || [];

    for (const s of statuses) {
      const statusMap = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };
      const mapped = statusMap[s.status];
      if (!mapped) continue;

      await prisma.whatsappMessage
        .updateMany({
          where: { providerMessageId: s.id },
          data: {
            status: mapped,
            ...(mapped === "DELIVERED" && { deliveredAt: new Date(Number(s.timestamp) * 1000) }),
            ...(mapped === "READ" && { readAt: new Date(Number(s.timestamp) * 1000) }),
          },
        })
        .catch(() => {});
    }

    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
