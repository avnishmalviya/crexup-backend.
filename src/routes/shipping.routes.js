const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { requireAdminAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAdminAuth);

// GET /api/shipping/campaign/:campaignId — shipping sheet data
// (creator name/phone/address/product/courier/tracking/status)
router.get("/campaign/:campaignId", async (req, res, next) => {
  try {
    const campaignCreators = await prisma.campaignCreator.findMany({
      where: {
        campaignId: req.params.campaignId,
        status: { in: ["ADDRESS_SUBMITTED", "SHIPPED", "DELIVERED", "CONTENT_SUBMITTED", "APPROVED", "POSTED", "COMPLETED"] },
      },
      include: { creator: true },
    });

    const shipments = await prisma.shipment.findMany({ where: { campaignId: req.params.campaignId } });
    const shipmentByCreator = Object.fromEntries(shipments.map((s) => [s.creatorId, s]));

    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.campaignId } });

    const sheet = campaignCreators.map((cc) => {
      const shipment = shipmentByCreator[cc.creatorId];
      return {
        creatorId: cc.creator.id,
        creatorName: cc.creator.fullName,
        phone: cc.shippingPhone || cc.creator.mobileNumber,
        address: [cc.shippingCity, cc.shippingState, cc.shippingPincode].filter(Boolean).join(", "),
        product: campaign?.product,
        courier: shipment?.courier || null,
        trackingNumber: shipment?.trackingNumber || null,
        shippingStatus: shipment?.status || "PENDING",
      };
    });

    res.json({ sheet });
  } catch (err) {
    next(err);
  }
});

// POST /api/shipping — create/update a shipment record for a creator on a campaign
const shipmentSchema = z.object({
  campaignId: z.string(),
  creatorId: z.string(),
  product: z.string().min(1),
  courier: z.string().optional(),
  trackingNumber: z.string().optional(),
  status: z.enum(["PENDING", "PACKED", "SHIPPED", "IN_TRANSIT", "DELIVERED", "RETURNED", "FAILED"]).optional(),
});

router.post("/", async (req, res, next) => {
  try {
    const data = shipmentSchema.parse(req.body);

    // No composite unique key on (campaignId, creatorId) in the schema, so
    // we find-then-create/update explicitly to keep one shipment per pairing.
    const existing = await prisma.shipment.findFirst({
      where: { campaignId: data.campaignId, creatorId: data.creatorId },
    });

    const shipment = existing
      ? await prisma.shipment.update({
          where: { id: existing.id },
          data: {
            courier: data.courier,
            trackingNumber: data.trackingNumber,
            status: data.status,
            ...(data.status === "SHIPPED" && { shippedAt: new Date() }),
            ...(data.status === "DELIVERED" && { deliveredAt: new Date() }),
          },
        })
      : await prisma.shipment.create({
          data: {
            campaignId: data.campaignId,
            creatorId: data.creatorId,
            product: data.product,
            courier: data.courier,
            trackingNumber: data.trackingNumber,
            status: data.status || "PENDING",
          },
        });

    if (data.status === "SHIPPED") {
      await prisma.campaignCreator.updateMany({
        where: { campaignId: data.campaignId, creatorId: data.creatorId },
        data: { status: "SHIPPED" },
      });
    }
    if (data.status === "DELIVERED") {
      await prisma.campaignCreator.updateMany({
        where: { campaignId: data.campaignId, creatorId: data.creatorId },
        data: { status: "DELIVERED" },
      });
    }

    res.status(201).json(shipment);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
