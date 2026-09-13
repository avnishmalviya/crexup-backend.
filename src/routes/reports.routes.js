const express = require("express");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const prisma = require("../lib/prisma");
const { requireAdminAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAdminAuth);

async function buildCampaignReportData(campaignId) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      creators: { include: { creator: true } },
    },
  });
  if (!campaign) return null;

  const performanceRows = await prisma.campaignPerformance.findMany({ where: { campaignId } });
  const contentSubmissions = await prisma.contentSubmission.findMany({ where: { campaignId } });

  const totals = performanceRows.reduce(
    (acc, r) => {
      acc.views += r.reelViews || 0;
      acc.reach += r.reach || 0;
      acc.engagement += (r.likes || 0) + (r.comments || 0) + (r.shares || 0) + (r.saves || 0);
      return acc;
    },
    { views: 0, reach: 0, engagement: 0 }
  );

  const avgEngagementRate = performanceRows.length
    ? Math.round((performanceRows.reduce((s, r) => s + (r.engagementRate || 0), 0) / performanceRows.length) * 100) / 100
    : 0;

  const creatorPerfById = Object.fromEntries(performanceRows.map((r) => [r.creatorId, r]));
  const topCreators = [...campaign.creators]
    .map((cc) => ({
      name: cc.creator.fullName,
      instagramUsername: cc.creator.instagramUsername,
      views: creatorPerfById[cc.creatorId]?.reelViews || 0,
      engagementRate: creatorPerfById[cc.creatorId]?.engagementRate || 0,
    }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 5);

  const completedCount = campaign.creators.filter((c) => c.status === "COMPLETED").length;
  const completionRate = campaign.creators.length ? (completedCount / campaign.creators.length) * 100 : 0;

  const roiSummary =
    campaign.budget && totals.engagement
      ? { costPerEngagement: Math.round((campaign.budget / totals.engagement) * 100) / 100 }
      : null;

  return {
    campaign,
    totalCreators: campaign.creators.length,
    totalViews: totals.views,
    totalReach: totals.reach,
    totalEngagement: totals.engagement,
    avgEngagementRate,
    topCreators,
    bestPerformingContent: [...contentSubmissions].sort((a, b) => (b.postingDate || 0) - (a.postingDate || 0)).slice(0, 5),
    completionRate: Math.round(completionRate * 10) / 10,
    roiSummary,
  };
}

// GET /api/reports/campaign/:campaignId — JSON report (for on-screen display)
router.get("/campaign/:campaignId", async (req, res, next) => {
  try {
    const report = await buildCampaignReportData(req.params.campaignId);
    if (!report) return res.status(404).json({ error: "Campaign not found" });
    res.json(report);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/campaign/:campaignId/excel — downloadable Excel report
router.get("/campaign/:campaignId/excel", async (req, res, next) => {
  try {
    const report = await buildCampaignReportData(req.params.campaignId);
    if (!report) return res.status(404).json({ error: "Campaign not found" });

    const workbook = new ExcelJS.Workbook();
    const summarySheet = workbook.addWorksheet("Summary");
    summarySheet.columns = [{ header: "Metric", key: "metric", width: 30 }, { header: "Value", key: "value", width: 20 }];
    summarySheet.addRows([
      { metric: "Campaign", value: report.campaign.name },
      { metric: "Brand", value: report.campaign.brandName },
      { metric: "Total Creators", value: report.totalCreators },
      { metric: "Total Views", value: report.totalViews },
      { metric: "Total Reach", value: report.totalReach },
      { metric: "Total Engagement", value: report.totalEngagement },
      { metric: "Avg Engagement Rate (%)", value: report.avgEngagementRate },
      { metric: "Completion Rate (%)", value: report.completionRate },
    ]);

    const creatorsSheet = workbook.addWorksheet("Top Creators");
    creatorsSheet.columns = [
      { header: "Name", key: "name", width: 25 },
      { header: "Instagram", key: "instagramUsername", width: 25 },
      { header: "Views", key: "views", width: 15 },
      { header: "Engagement Rate (%)", key: "engagementRate", width: 20 },
    ];
    creatorsSheet.addRows(report.topCreators);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${report.campaign.campaignCode}-report.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/campaign/:campaignId/pdf — downloadable PDF report
router.get("/campaign/:campaignId/pdf", async (req, res, next) => {
  try {
    const report = await buildCampaignReportData(req.params.campaignId);
    if (!report) return res.status(404).json({ error: "Campaign not found" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${report.campaign.campaignCode}-report.pdf"`);

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    doc.fontSize(20).text(`Campaign Report: ${report.campaign.name}`, { underline: true });
    doc.moveDown();
    doc.fontSize(12).text(`Brand: ${report.campaign.brandName}`);
    doc.text(`Campaign Code: ${report.campaign.campaignCode}`);
    doc.moveDown();

    doc.fontSize(14).text("Summary", { underline: true });
    doc.fontSize(11);
    doc.text(`Total Creators: ${report.totalCreators}`);
    doc.text(`Total Views: ${report.totalViews}`);
    doc.text(`Total Reach: ${report.totalReach}`);
    doc.text(`Total Engagement: ${report.totalEngagement}`);
    doc.text(`Average Engagement Rate: ${report.avgEngagementRate}%`);
    doc.text(`Completion Rate: ${report.completionRate}%`);
    doc.moveDown();

    doc.fontSize(14).text("Top Performing Creators", { underline: true });
    doc.fontSize(11);
    report.topCreators.forEach((c, i) => {
      doc.text(`${i + 1}. ${c.name} (@${c.instagramUsername}) — ${c.views} views, ${c.engagementRate}% engagement`);
    });

    if (report.roiSummary) {
      doc.moveDown();
      doc.fontSize(14).text("ROI Summary", { underline: true });
      doc.fontSize(11).text(`Cost per Engagement: ₹${report.roiSummary.costPerEngagement}`);
    }

    doc.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
