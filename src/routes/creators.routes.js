const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { requireAdminAuth } = require("../middleware/auth");
const { analyzeInstagramProfile } = require("../services/instagramService");
const { computeCreatorScores } = require("../services/scoringEngine");

const router = express.Router();
router.use(requireAdminAuth);

// ---------------------------------------------------------------------
// GET /api/creators — Smart Creator Search
// Supports combinable filters + free-text search across name/username/mobile
// ---------------------------------------------------------------------
router.get("/", async (req, res, next) => {
  try {
    const {
      q, // free text: name / instagram username / mobile
      state,
      city,
      language,
      gender,
      category,
      niche,
      availabilityStatus,
      collaborationStatus,
      verificationStatus,
      minFollowers,
      maxFollowers,
      minEngagement,
      minReelViews,
      minCreatorScore,
      minReliabilityScore,
      minBrandFriendlyScore,
      maxFakeFollowerRisk,
      hasCampaignExperience, // "true" | "false"
      page = "1",
      pageSize = "25",
      sortBy = "creatorScore", // creatorScore | followers | engagementRate | createdAt
      sortDir = "desc",
    } = req.query;

    const where = { AND: [] };

    if (q) {
      where.AND.push({
        OR: [
          { fullName: { contains: q, mode: "insensitive" } },
          { instagramUsername: { contains: q, mode: "insensitive" } },
          { mobileNumber: { contains: q } },
        ],
      });
    }
    if (state) where.AND.push({ state });
    if (city) where.AND.push({ city });
    if (language) where.AND.push({ language });
    if (gender) where.AND.push({ gender });
    if (category) where.AND.push({ contentCategory: category });
    if (niche) where.AND.push({ contentNiche: niche });
    if (availabilityStatus) where.AND.push({ availabilityStatus });
    if (collaborationStatus) where.AND.push({ collaborationStatus });
    if (verificationStatus) where.AND.push({ verificationStatus });

    if (minFollowers || maxFollowers) {
      where.AND.push({
        instagramProfile: {
          followers: {
            ...(minFollowers && { gte: Number(minFollowers) }),
            ...(maxFollowers && { lte: Number(maxFollowers) }),
          },
        },
      });
    }
    if (minEngagement) {
      where.AND.push({ instagramProfile: { engagementRate: { gte: Number(minEngagement) } } });
    }
    if (minReelViews) {
      where.AND.push({ instagramProfile: { avgReelViews: { gte: Number(minReelViews) } } });
    }
    if (minCreatorScore) {
      where.AND.push({ scores: { creatorScore: { gte: Number(minCreatorScore) } } });
    }
    if (minReliabilityScore) {
      where.AND.push({ scores: { reliabilityScore: { gte: Number(minReliabilityScore) } } });
    }
    if (minBrandFriendlyScore) {
      where.AND.push({ scores: { brandFriendlyScore: { gte: Number(minBrandFriendlyScore) } } });
    }
    if (maxFakeFollowerRisk) {
      where.AND.push({ scores: { fakeFollowerRisk: { lte: Number(maxFakeFollowerRisk) } } });
    }
    if (hasCampaignExperience === "true") {
      where.AND.push({ performance: { totalCampaigns: { gt: 0 } } });
    } else if (hasCampaignExperience === "false") {
      where.AND.push({ OR: [{ performance: null }, { performance: { totalCampaigns: 0 } }] });
    }

    const take = Math.min(100, Number(pageSize));
    const skip = (Number(page) - 1) * take;

    // Sorting on nested relations (scores/instagramProfile) needs a raw
    // orderBy on the relation object per Prisma's relational sort syntax.
    const orderBy = buildOrderBy(sortBy, sortDir);

    const [creators, total] = await Promise.all([
      prisma.creator.findMany({
        where,
        include: { instagramProfile: true, scores: true, performance: true, rating: true },
        orderBy,
        take,
        skip,
      }),
      prisma.creator.count({ where }),
    ]);

    res.json({ creators, total, page: Number(page), pageSize: take, totalPages: Math.ceil(total / take) });
  } catch (err) {
    next(err);
  }
});

function buildOrderBy(sortBy, sortDir) {
  const dir = sortDir === "asc" ? "asc" : "desc";
  if (["creatorScore", "engagementScore", "reliabilityScore", "brandFriendlyScore", "fakeFollowerRisk"].includes(sortBy)) {
    return { scores: { [sortBy]: dir } };
  }
  if (["followers", "engagementRate", "avgReelViews"].includes(sortBy)) {
    return { instagramProfile: { [sortBy]: dir } };
  }
  return { createdAt: dir };
}

// ---------------------------------------------------------------------
// GET /api/creators/:id — full profile
// ---------------------------------------------------------------------
router.get("/:id", async (req, res, next) => {
  try {
    const creator = await prisma.creator.findUnique({
      where: { id: req.params.id },
      include: {
        instagramProfile: true,
        scores: true,
        performance: true,
        rating: true,
        documents: true,
        notes: { orderBy: { createdAt: "desc" }, include: { admin: { select: { name: true } }, campaign: { select: { name: true } } } },
        campaignCreators: {
          include: { campaign: true },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!creator) return res.status(404).json({ error: "Creator not found" });
    res.json(creator);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// PATCH /api/creators/:id — admin edit (profile fields, status, manual
// Instagram override when API data is unavailable)
// ---------------------------------------------------------------------
const updateCreatorSchema = z.object({
  fullName: z.string().optional(),
  instagramUrl: z.string().url().optional(),
  mobileNumber: z.string().optional(),
  whatsappNumber: z.string().optional(),
  email: z.string().email().optional(),
  gender: z.enum(["MALE", "FEMALE", "OTHER", "PREFER_NOT_TO_SAY"]).optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  language: z.string().optional(),
  contentCategory: z.string().optional(),
  contentNiche: z.string().optional(),
  upiId: z.string().optional(),
  verificationStatus: z.enum(["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"]).optional(),
  availabilityStatus: z.enum(["AVAILABLE", "BUSY", "ON_CAMPAIGN", "UNAVAILABLE"]).optional(),
  collaborationStatus: z.enum(["NEW", "CONTACTED", "IN_TALKS", "ACTIVE", "DORMANT", "BLACKLISTED"]).optional(),
});

router.patch("/:id", async (req, res, next) => {
  try {
    const data = updateCreatorSchema.parse(req.body);
    const creator = await prisma.creator.update({ where: { id: req.params.id }, data });
    await logActivity(req, "CREATOR_UPDATED", "Creator", creator.id, data);
    res.json(creator);
  } catch (err) {
    next(err);
  }
});

// Manual Instagram metric override (used when Graph API can't supply a field)
const manualInstagramSchema = z.object({
  followers: z.number().optional(),
  following: z.number().optional(),
  totalPosts: z.number().optional(),
  avgReelViews: z.number().optional(),
  avgLikes: z.number().optional(),
  avgComments: z.number().optional(),
  engagementRate: z.number().optional(),
  postingFrequency: z.number().optional(),
  bio: z.string().optional(),
  profilePictureUrl: z.string().url().optional(),
  audienceCountry: z.record(z.number()).optional(),
  audienceCity: z.record(z.number()).optional(),
  audienceGender: z.record(z.number()).optional(),
  audienceAge: z.record(z.number()).optional(),
  audienceInterests: z.record(z.number()).optional(),
});

router.put("/:id/instagram-profile", async (req, res, next) => {
  try {
    const data = manualInstagramSchema.parse(req.body);

    const instagramProfile = await prisma.instagramProfile.upsert({
      where: { creatorId: req.params.id },
      update: { ...data, dataSource: "MANUAL", isStale: false },
      create: { creatorId: req.params.id, ...data, dataSource: "MANUAL", isStale: false },
    });

    const performance = await prisma.creatorPerformance.findUnique({ where: { creatorId: req.params.id } });
    const scores = computeCreatorScores(instagramProfile, performance);
    await prisma.creatorScore.upsert({
      where: { creatorId: req.params.id },
      update: scores,
      create: { creatorId: req.params.id, ...scores },
    });

    await logActivity(req, "INSTAGRAM_MANUAL_OVERRIDE", "Creator", req.params.id, data);
    res.json({ instagramProfile, scores });
  } catch (err) {
    next(err);
  }
});

// Re-run Instagram Graph API analysis + recompute scores
router.post("/:id/refresh-instagram", async (req, res, next) => {
  try {
    const creator = await prisma.creator.findUnique({ where: { id: req.params.id } });
    if (!creator) return res.status(404).json({ error: "Creator not found" });

    const analysis = await analyzeInstagramProfile(creator.instagramUsername);
    const instagramProfile = await prisma.instagramProfile.upsert({
      where: { creatorId: creator.id },
      update: analysis,
      create: { creatorId: creator.id, ...analysis },
    });

    const performance = await prisma.creatorPerformance.findUnique({ where: { creatorId: creator.id } });
    const scores = computeCreatorScores(instagramProfile, performance);
    await prisma.creatorScore.upsert({
      where: { creatorId: creator.id },
      update: scores,
      create: { creatorId: creator.id, ...scores },
    });

    res.json({ instagramProfile, scores });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Creator Notes (positive/negative observations)
// ---------------------------------------------------------------------
const noteSchema = z.object({
  category: z.enum(["POSITIVE", "NEGATIVE"]),
  text: z.string().min(1),
  campaignId: z.string().optional(),
});

router.post("/:id/notes", async (req, res, next) => {
  try {
    const data = noteSchema.parse(req.body);
    const note = await prisma.creatorNote.create({
      data: {
        creatorId: req.params.id,
        adminId: req.admin.id,
        category: data.category,
        text: data.text,
        campaignId: data.campaignId,
      },
    });
    res.status(201).json(note);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/notes", async (req, res, next) => {
  try {
    const notes = await prisma.creatorNote.findMany({
      where: { creatorId: req.params.id },
      orderBy: { createdAt: "desc" },
      include: { admin: { select: { name: true } }, campaign: { select: { name: true } } },
    });
    res.json(notes);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Creator Rating ("Creator Score" card) — manual admin-entered stars,
// separate from the AI-computed CreatorScore.
// ---------------------------------------------------------------------
const ratingSchema = z.object({
  contentQuality: z.number().int().min(0).max(5),
  communication: z.number().int().min(0).max(5),
  onTimeDelivery: z.number().int().min(0).max(5),
  campaignPerformance: z.number().int().min(0).max(5),
  brandFit: z.number().int().min(0).max(5),
  reliability: z.enum(["EXCELLENT", "GOOD", "AVERAGE", "POOR"]),
  description: z.string().optional(),
});

router.put("/:id/rating", async (req, res, next) => {
  try {
    const data = ratingSchema.parse(req.body);

    // Overall Score is auto-calculated: average of the 5 stars, scaled to /10
    const avgStars =
      (data.contentQuality + data.communication + data.onTimeDelivery + data.campaignPerformance + data.brandFit) / 5;
    const overallScore = Math.round(avgStars * 2 * 10) / 10; // e.g. 4.4 stars -> 8.8/10

    const rating = await prisma.creatorRating.upsert({
      where: { creatorId: req.params.id },
      update: { ...data, overallScore, lastReviewedAt: new Date(), lastReviewedById: req.admin.id },
      create: { creatorId: req.params.id, ...data, overallScore, lastReviewedById: req.admin.id },
    });

    await logActivity(req, "CREATOR_RATED", "Creator", req.params.id, { overallScore });
    res.json(rating);
  } catch (err) {
    next(err);
  }
});

async function logActivity(req, action, entityType, entityId, metadata) {
  try {
    await prisma.activityLog.create({
      data: { adminId: req.admin.id, action, entityType, entityId, metadata },
    });
  } catch (e) {
    // Logging failures should never break the primary request.
    console.error("Activity log failed:", e.message);
  }
}

module.exports = router;
