const express = require("express");
const prisma = require("../lib/prisma");
const { requireAdminAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAdminAuth);

// GET /api/dashboard/summary
router.get("/summary", async (req, res, next) => {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [
      totalCreators,
      verifiedCreators,
      activeCampaigns,
      totalCampaigns,
      completedCampaigns,
      creatorsAddedThisMonth,
      recentRegistrations,
      allScores,
    ] = await Promise.all([
      prisma.creator.count(),
      prisma.creator.count({ where: { verificationStatus: "VERIFIED" } }),
      prisma.campaign.count({ where: { stage: { notIn: ["COMPLETED", "CANCELLED", "DRAFT"] } } }),
      prisma.campaign.count(),
      prisma.campaign.count({ where: { stage: "COMPLETED" } }),
      prisma.creator.count({ where: { createdAt: { gte: startOfMonth } } }),
      prisma.creator.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, fullName: true, instagramUsername: true, creatorCode: true, createdAt: true, verificationStatus: true },
      }),
      prisma.instagramProfile.findMany({ select: { engagementRate: true } }),
    ]);

    const campaignCompletionRate = totalCampaigns ? Math.round((completedCampaigns / totalCampaigns) * 1000) / 10 : 0;
    const averageEngagement = allScores.length
      ? Math.round((allScores.reduce((sum, s) => sum + (s.engagementRate || 0), 0) / allScores.length) * 100) / 100
      : 0;

    const campaignTimeline = await prisma.campaign.findMany({
      orderBy: { createdAt: "desc" },
      take: 15,
      select: { id: true, campaignCode: true, name: true, brandName: true, stage: true, deadline: true, createdAt: true },
    });

    res.json({
      totalCreators,
      verifiedCreators,
      activeCampaigns,
      campaignCompletionRate,
      averageEngagement,
      creatorsAddedThisMonth,
      recentRegistrations,
      campaignTimeline,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
