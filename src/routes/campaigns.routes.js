const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { requireAdminAuth } = require("../middleware/auth");
const { nextCampaignCode } = require("../lib/ids");
const { rankCreatorsForCampaign } = require("../services/recommendationEngine");

const router = express.Router();
router.use(requireAdminAuth);

const createCampaignSchema = z.object({
  name: z.string().min(1),
  brandName: z.string().min(1),
  product: z.string().min(1),
  goal: z.string().optional(),
  budget: z.number().optional(),
  productValue: z.number().optional(),
  creatorPayment: z.number().optional(),
  deliverables: z.string().optional(),
  deadline: z.string().datetime().optional(),
  hashtags: z.array(z.string()).optional(),
  captionGuidelines: z.string().optional(),
  contentGuidelines: z.string().optional(),
  referenceVideoUrls: z.array(z.string().url()).optional(),
  // Optional: pass creatorIds to shortlist immediately on creation
  creatorIds: z.array(z.string()).optional(),
});

// POST /api/campaigns — create a campaign (Draft), optionally shortlisting creators immediately
router.post("/", async (req, res, next) => {
  try {
    const data = createCampaignSchema.parse(req.body);
    const campaignCode = await nextCampaignCode();

    const campaign = await prisma.campaign.create({
      data: {
        campaignCode,
        name: data.name,
        brandName: data.brandName,
        product: data.product,
        goal: data.goal,
        budget: data.budget,
        productValue: data.productValue,
        creatorPayment: data.creatorPayment,
        deliverables: data.deliverables,
        deadline: data.deadline ? new Date(data.deadline) : undefined,
        hashtags: data.hashtags || [],
        captionGuidelines: data.captionGuidelines,
        contentGuidelines: data.contentGuidelines,
        referenceVideoUrls: data.referenceVideoUrls || [],
        createdById: req.admin.id,
      },
    });

    if (data.creatorIds?.length) {
      await shortlistCreators(campaign.id, data.creatorIds);
    }

    res.status(201).json(campaign);
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns — list with stage filter
router.get("/", async (req, res, next) => {
  try {
    const { stage, page = "1", pageSize = "25" } = req.query;
    const take = Math.min(100, Number(pageSize));
    const skip = (Number(page) - 1) * take;

    const where = stage ? { stage } : {};
    const [campaigns, total] = await Promise.all([
      prisma.campaign.findMany({
        where,
        include: { _count: { select: { creators: true } } },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      prisma.campaign.count({ where }),
    ]);

    res.json({ campaigns, total, page: Number(page), pageSize: take, totalPages: Math.ceil(total / take) });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns/:id — full detail incl. creators + pipeline state
router.get("/:id", async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.id },
      include: {
        creators: {
          include: {
            creator: { include: { instagramProfile: true, scores: true, performance: true } },
          },
        },
        whatsappMessages: { orderBy: { createdAt: "desc" } },
        contentSubmissions: true,
        shipments: true,
        performance: true,
      },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    res.json(campaign);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/campaigns/:id — edit fields or move overall stage
const updateCampaignSchema = createCampaignSchema.partial().omit({ creatorIds: true }).extend({
  stage: z
    .enum([
      "DRAFT",
      "CREATOR_SHORTLISTED",
      "INVITATION_SENT",
      "CREATOR_ACCEPTED",
      "ADDRESS_SUBMITTED",
      "PRODUCT_SHIPPED",
      "DELIVERED",
      "CONTENT_SUBMITTED",
      "REVISION_REQUIRED",
      "APPROVED",
      "POSTED",
      "COMPLETED",
      "CANCELLED",
    ])
    .optional(),
});

router.patch("/:id", async (req, res, next) => {
  try {
    const data = updateCampaignSchema.parse(req.body);
    const updateData = { ...data };
    if (data.deadline) updateData.deadline = new Date(data.deadline);

    const campaign = await prisma.campaign.update({ where: { id: req.params.id }, data: updateData });
    res.json(campaign);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Creator shortlisting with AI recommendation ranking
// ---------------------------------------------------------------------

// GET /api/campaigns/:id/recommendations?niche=&category=&state=&language=
// Ranks ALL eligible creators against this campaign's context — used by the
// admin before shortlisting, to see the ⭐ recommendation badges.
router.get("/:id/recommendations", async (req, res, next) => {
  try {
    const { niche, category, state, language, limit = "50" } = req.query;

    const creators = await prisma.creator.findMany({
      where: {
        availabilityStatus: { not: "UNAVAILABLE" },
        collaborationStatus: { not: "BLACKLISTED" },
      },
      include: { instagramProfile: true, scores: true, performance: true },
      take: Number(limit) * 3, // pull extra, then rank + trim
    });

    const ranked = rankCreatorsForCampaign(creators, { niche, category, state, language }).slice(
      0,
      Number(limit)
    );

    res.json({ creators: ranked });
  } catch (err) {
    next(err);
  }
});

const shortlistSchema = z.object({ creatorIds: z.array(z.string()).min(1) });

// POST /api/campaigns/:id/shortlist — bulk-add creators to a campaign
router.post("/:id/shortlist", async (req, res, next) => {
  try {
    const { creatorIds } = shortlistSchema.parse(req.body);
    const created = await shortlistCreators(req.params.id, creatorIds);
    await prisma.campaign.update({
      where: { id: req.params.id },
      data: { stage: "CREATOR_SHORTLISTED" },
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

async function shortlistCreators(campaignId, creatorIds) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  const creators = await prisma.creator.findMany({
    where: { id: { in: creatorIds } },
    include: { instagramProfile: true, scores: true, performance: true },
  });

  const ranked = rankCreatorsForCampaign(creators, {}); // context-free ranking snapshot at shortlist time

  return Promise.all(
    ranked.map((c) =>
      prisma.campaignCreator.upsert({
        where: { campaignId_creatorId: { campaignId, creatorId: c.id } },
        update: {
          recommendationScore: c.recommendation.matchScore,
          recommendationTier: c.recommendation.tier,
        },
        create: {
          campaignId,
          creatorId: c.id,
          status: "SHORTLISTED",
          recommendationScore: c.recommendation.matchScore,
          recommendationTier: c.recommendation.tier,
        },
      })
    )
  );
}

// PATCH /api/campaigns/:campaignId/creators/:creatorId — move a single
// creator through the per-creator pipeline (accept, decline, ship, deliver,
// approve content, post, complete, or set ratings)
const creatorStatusSchema = z.object({
  status: z
    .enum([
      "SHORTLISTED",
      "INVITED",
      "ACCEPTED",
      "DECLINED",
      "ADDRESS_SUBMITTED",
      "SHIPPED",
      "DELIVERED",
      "CONTENT_SUBMITTED",
      "REVISION_REQUESTED",
      "APPROVED",
      "POSTED",
      "COMPLETED",
      "REMOVED",
    ])
    .optional(),
  brandRating: z.number().min(0).max(5).optional(),
  adminRating: z.number().min(0).max(5).optional(),
});

router.patch("/:campaignId/creators/:creatorId", async (req, res, next) => {
  try {
    const data = creatorStatusSchema.parse(req.body);
    const updated = await prisma.campaignCreator.update({
      where: { campaignId_creatorId: { campaignId: req.params.campaignId, creatorId: req.params.creatorId } },
      data,
    });

    if (data.status === "COMPLETED") {
      await rollUpCreatorPerformance(req.params.creatorId);
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

/**
 * Recomputes CreatorPerformance from all completed CampaignCreator +
 * CampaignPerformance rows. Called whenever a campaign-creator pairing is
 * marked COMPLETED. Also triggers a score recalculation so search/ranking
 * stay current.
 */
async function rollUpCreatorPerformance(creatorId) {
  const allPairings = await prisma.campaignCreator.findMany({ where: { creatorId } });
  const completed = allPairings.filter((c) => c.status === "COMPLETED");
  const accepted = allPairings.filter((c) => c.status !== "SHORTLISTED" && c.status !== "INVITED");

  const totalCampaigns = completed.length;
  const completionRate = allPairings.length ? (completed.length / allPairings.length) * 100 : 0;
  const acceptanceRate = allPairings.length
    ? (allPairings.filter((c) => c.status !== "DECLINED" && c.status !== "SHORTLISTED" && c.status !== "INVITED").length /
        allPairings.length) *
      100
    : 0;

  const ratedPairings = completed.filter((c) => c.brandRating != null || c.adminRating != null);
  const brandRatingAvg = avg(ratedPairings.map((c) => c.brandRating).filter((v) => v != null));
  const adminRatingAvg = avg(ratedPairings.map((c) => c.adminRating).filter((v) => v != null));

  const perfRows = await prisma.campaignPerformance.findMany({ where: { creatorId } });
  const avgViews = avg(perfRows.map((p) => p.reelViews));
  const avgReach = avg(perfRows.map((p) => p.reach));
  const avgEngagement = avg(perfRows.map((p) => p.engagementRate).filter((v) => v != null));
  const avgSaves = avg(perfRows.map((p) => p.saves));
  const avgShares = avg(perfRows.map((p) => p.shares));

  // On-time delivery rate would ideally compare Shipment.deliveredAt vs
  // campaign.deadline; approximated here via completed/accepted ratio until
  // shipment timestamps are wired to campaign deadlines end-to-end.
  const onTimeDeliveryRate = completionRate;

  const performance = await prisma.creatorPerformance.upsert({
    where: { creatorId },
    update: {
      totalCampaigns,
      avgViews,
      avgReach,
      avgEngagement,
      avgSaves,
      avgShares,
      completionRate,
      onTimeDeliveryRate,
      acceptanceRate,
      brandRatingAvg,
      adminRatingAvg,
      avgPerformanceScore: avg([avgEngagement, completionRate, brandRatingAvg * 20]),
    },
    create: {
      creatorId,
      totalCampaigns,
      avgViews,
      avgReach,
      avgEngagement,
      avgSaves,
      avgShares,
      completionRate,
      onTimeDeliveryRate,
      acceptanceRate,
      brandRatingAvg,
      adminRatingAvg,
      avgPerformanceScore: avg([avgEngagement, completionRate, brandRatingAvg * 20]),
    },
  });

  // Reliability/brand-friendly scores depend on performance — recompute.
  const { computeCreatorScores } = require("../services/scoringEngine");
  const instagramProfile = await prisma.instagramProfile.findUnique({ where: { creatorId } });
  if (instagramProfile) {
    const scores = computeCreatorScores(instagramProfile, performance);
    await prisma.creatorScore.upsert({
      where: { creatorId },
      update: scores,
      create: { creatorId, ...scores },
    });
  }
}

function avg(nums) {
  const clean = nums.filter((n) => typeof n === "number" && !Number.isNaN(n));
  if (!clean.length) return 0;
  return Math.round((clean.reduce((a, b) => a + b, 0) / clean.length) * 100) / 100;
}

module.exports = router;
