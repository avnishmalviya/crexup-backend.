const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { nextCreatorCode } = require("../lib/ids");
const { analyzeInstagramProfile } = require("../services/instagramService");
const { computeCreatorScores } = require("../services/scoringEngine");

const router = express.Router();

// ---------------------------------------------------------------------
// 1) Creator Registration Form (public, no login)
// ---------------------------------------------------------------------
const creatorRegistrationSchema = z.object({
  fullName: z.string().min(2),
  instagramUsername: z.string().min(1).transform((s) => s.replace(/^@/, "").trim().toLowerCase()),
  instagramUrl: z.string().url().optional(),
  mobileNumber: z.string().min(8),
  whatsappNumber: z.string().min(8),
  email: z.string().email(),
  gender: z.enum(["MALE", "FEMALE", "OTHER", "PREFER_NOT_TO_SAY"]).optional(),
  state: z.string().min(1),
  city: z.string().min(1),
  language: z.string().min(1),
  contentCategory: z.string().min(1),
  contentNiche: z.string().min(1),
  upiId: z.string().optional(),
});

router.post("/creators/register", async (req, res, next) => {
  try {
    const data = creatorRegistrationSchema.parse(req.body);

    const existing = await prisma.creator.findUnique({
      where: { instagramUsername: data.instagramUsername },
    });
    if (existing) {
      return res.status(409).json({ error: "A creator with this Instagram username is already registered." });
    }

    const creatorCode = await nextCreatorCode();

    const creator = await prisma.creator.create({
      data: { ...data, creatorCode },
    });

    // Fire-and-continue: analyze Instagram + compute scores right away so
    // the admin dashboard shows a fully-scored profile without manual work.
    // Any failure here (e.g. API down) should not block registration —
    // the admin can retry via POST /api/creators/:id/refresh-instagram.
    try {
      const analysis = await analyzeInstagramProfile(data.instagramUsername);
      const instagramProfile = await prisma.instagramProfile.create({
        data: { creatorId: creator.id, ...analysis },
      });

      const scores = computeCreatorScores(instagramProfile, null);
      await prisma.creatorScore.create({ data: { creatorId: creator.id, ...scores } });
    } catch (analysisErr) {
      // eslint-disable-next-line no-console
      console.error(`Instagram analysis failed for ${data.instagramUsername}:`, analysisErr.message);
    }

    res.status(201).json({
      message: "Registration successful. Our team will review your profile shortly.",
      creatorCode: creator.creatorCode,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// 2) Campaign Confirmation Form (public, no login) — creator accepts +
//    submits shipping details for a campaign they were invited to.
// ---------------------------------------------------------------------
const campaignConfirmationSchema = z.object({
  campaignCreatorId: z.string(), // id of the CampaignCreator row (sent via WhatsApp link)
  accept: z.boolean(),
  shippingCity: z.string().optional(),
  shippingState: z.string().optional(),
  shippingPincode: z.string().optional(),
  shippingUpi: z.string().optional(),
  shippingPhone: z.string().optional(),
});

router.post("/campaigns/confirm", async (req, res, next) => {
  try {
    const data = campaignConfirmationSchema.parse(req.body);

    const campaignCreator = await prisma.campaignCreator.findUnique({
      where: { id: data.campaignCreatorId },
    });
    if (!campaignCreator) return res.status(404).json({ error: "Invitation not found" });

    if (!data.accept) {
      const updated = await prisma.campaignCreator.update({
        where: { id: data.campaignCreatorId },
        data: { status: "DECLINED" },
      });
      return res.json({ message: "Response recorded.", status: updated.status });
    }

    const updated = await prisma.campaignCreator.update({
      where: { id: data.campaignCreatorId },
      data: {
        status: "ADDRESS_SUBMITTED",
        shippingCity: data.shippingCity,
        shippingState: data.shippingState,
        shippingPincode: data.shippingPincode,
        shippingUpi: data.shippingUpi,
        shippingPhone: data.shippingPhone,
        termsAcceptedAt: new Date(),
      },
    });

    res.json({ message: "Campaign accepted. Address submitted.", status: updated.status });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// 3) Content Submission Form (public, no login)
// ---------------------------------------------------------------------
const contentSubmissionSchema = z.object({
  campaignId: z.string(),
  creatorId: z.string(),
  reelLink: z.string().url().optional(),
  storyLink: z.string().url().optional(),
  postingDate: z.string().datetime().optional(),
  caption: z.string().optional(),
  screenshotUrl: z.string().url().optional(),
});

router.post("/content/submit", async (req, res, next) => {
  try {
    const data = contentSubmissionSchema.parse(req.body);

    const submission = await prisma.contentSubmission.create({
      data: {
        campaignId: data.campaignId,
        creatorId: data.creatorId,
        reelLink: data.reelLink,
        storyLink: data.storyLink,
        postingDate: data.postingDate ? new Date(data.postingDate) : null,
        caption: data.caption,
        screenshotUrl: data.screenshotUrl,
      },
    });

    await prisma.campaignCreator.updateMany({
      where: { campaignId: data.campaignId, creatorId: data.creatorId },
      data: { status: "CONTENT_SUBMITTED" },
    });

    res.status(201).json({ message: "Content submitted for review.", submissionId: submission.id });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// 4) Brand Inquiry Form (public, no login)
// ---------------------------------------------------------------------
const brandInquirySchema = z.object({
  brandName: z.string().min(1),
  contactName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(8),
  budget: z.string().optional(),
  campaignGoal: z.string().optional(),
  message: z.string().optional(),
});

router.post("/brand-inquiry", async (req, res, next) => {
  try {
    const data = brandInquirySchema.parse(req.body);
    const inquiry = await prisma.brandInquiry.create({ data });
    res.status(201).json({ message: "Thanks! Our team will reach out shortly.", inquiryId: inquiry.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
