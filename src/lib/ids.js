const prisma = require("./prisma");

/**
 * Generates a human-friendly, zero-padded sequential code, e.g. CRX-000123.
 * Uses a simple count-based approach; for very high write concurrency this
 * should be swapped for a DB sequence, but is safe enough for admin-only
 * write volume (bulk creator imports, campaign creation).
 */
async function nextCreatorCode() {
  const count = await prisma.creator.count();
  return `CRX-${String(count + 1).padStart(6, "0")}`;
}

async function nextCampaignCode() {
  const count = await prisma.campaign.count();
  return `CMP-${String(count + 1).padStart(6, "0")}`;
}

module.exports = { nextCreatorCode, nextCampaignCode };
