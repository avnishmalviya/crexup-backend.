const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { requireAdminAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAdminAuth);

// GET /api/content/campaign/:campaignId — all submissions for a campaign
router.get("/campaign/:campaignId", async (req, res, next) => {
  try {
    const submissions = await prisma.contentSubmission.findMany({
      where: { campaignId: req.params.campaignId },
      include: { creator: { select: { fullName: true, instagramUsername: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(submissions);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/content/:id/review — approve / reject / request revision
const reviewSchema = z.object({
  reviewStatus: z.enum(["APPROVED", "REJECTED", "REVISION_REQUESTED"]),
  reviewComment: z.string().optional(),
});

router.patch("/:id/review", async (req, res, next) => {
  try {
    const data = reviewSchema.parse(req.body);

    const submission = await prisma.contentSubmission.update({
      where: { id: req.params.id },
      data: {
        reviewStatus: data.reviewStatus,
        reviewComment: data.reviewComment,
        reviewedById: req.admin.id,
        reviewedAt: new Date(),
      },
    });

    const statusMap = {
      APPROVED: "APPROVED",
      REJECTED: "REVISION_REQUESTED", // rejected content goes back for revision, not a dead end
      REVISION_REQUESTED: "REVISION_REQUESTED",
    };

    await prisma.campaignCreator.updateMany({
      where: { campaignId: submission.campaignId, creatorId: submission.creatorId },
      data: { status: statusMap[data.reviewStatus] },
    });

    if (data.reviewStatus === "APPROVED") {
      await prisma.campaign
        .update({ where: { id: submission.campaignId }, data: { stage: "APPROVED" } })
        .catch(() => {});
    } else {
      await prisma.campaign
        .update({ where: { id: submission.campaignId }, data: { stage: "REVISION_REQUIRED" } })
        .catch(() => {});
    }

    res.json(submission);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
