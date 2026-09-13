const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { requireAdminAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAdminAuth);

const performanceSchema = z.object({
  campaignId: z.string(),
  creatorId: z.string(),
  reelViews: z.number().optional(),
  reach: z.number().optional(),
  likes: z.number().optional(),
  comments: z.number().optional(),
  shares: z.number().optional(),
  saves: z.number().optional(),
  profileVisits: z.number().optional(),
  websiteClicks: z.number().optional(),
  storyViews: z.number().optional(),
  linkClicks: z.number().optional(),
  spend: z.number().optional(), // used to derive CPV/CPE if provided
  dataSource: z.enum(["MANUAL", "IMPORTED"]).optional(),
});

// POST /api/performance — enter or import performance metrics for a
// creator's deliverable on a campaign. Idempotent per (campaignId, creatorId).
router.post("/", async (req, res, next) => {
  try {
    const data = performanceSchema.parse(req.body);

    const engagementRate =
      data.reach && data.reach > 0
        ? (((data.likes || 0) + (data.comments || 0) + (data.shares || 0) + (data.saves || 0)) / data.reach) * 100
        : undefined;

    const cpv = data.spend && data.reelViews ? data.spend / data.reelViews : undefined;
    const cpe = data.spend && engagementRate ? data.spend / ((engagementRate / 100) * (data.reach || 1)) : undefined;

    const existing = await prisma.campaignPerformance.findFirst({
      where: { campaignId: data.campaignId, creatorId: data.creatorId },
    });

    const payload = {
      reelViews: data.reelViews || 0,
      reach: data.reach || 0,
      likes: data.likes || 0,
      comments: data.comments || 0,
      shares: data.shares || 0,
      saves: data.saves || 0,
      profileVisits: data.profileVisits || 0,
      websiteClicks: data.websiteClicks || 0,
      storyViews: data.storyViews || 0,
      linkClicks: data.linkClicks || 0,
      engagementRate,
      cpv,
      cpe,
      dataSource: data.dataSource || "MANUAL",
    };

    const record = existing
      ? await prisma.campaignPerformance.update({ where: { id: existing.id }, data: payload })
      : await prisma.campaignPerformance.create({
          data: { campaignId: data.campaignId, creatorId: data.creatorId, ...payload },
        });

    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

// GET /api/performance/campaign/:campaignId — all creator metrics for a campaign
router.get("/campaign/:campaignId", async (req, res, next) => {
  try {
    const rows = await prisma.campaignPerformance.findMany({ where: { campaignId: req.params.campaignId } });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
