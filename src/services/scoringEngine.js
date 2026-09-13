/**
 * Crexup Scoring Engine
 * ---------------------
 * Pure, deterministic functions that turn raw Instagram + campaign-history
 * data into the scores the platform relies on everywhere (search filters,
 * recommendation badges, creator profile, reports).
 *
 * All scores are 0-100 except fakeFollowerRisk (0-100, higher = riskier).
 * These are heuristic formulas, not a trained ML model — they're deliberately
 * transparent and swappable. To plug in a real model later, replace the
 * body of `computeCreatorScores` with a call out to your model and keep the
 * same return shape.
 */

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function safeDiv(numerator, denominator, fallback = 0) {
  if (!denominator || Number.isNaN(denominator)) return fallback;
  return numerator / denominator;
}

/**
 * @param {object} instagram - InstagramProfile row
 * @param {object} performance - CreatorPerformance row (may be null for new creators)
 */
function computeCreatorScores(instagram, performance) {
  const followers = instagram?.followers || 0;
  const engagementRate = instagram?.engagementRate || 0; // percentage, e.g. 4.2
  const avgReelViews = instagram?.avgReelViews || 0;
  const postingFrequency = instagram?.postingFrequency || 0; // posts/week
  const avgLikes = instagram?.avgLikes || 0;
  const avgComments = instagram?.avgComments || 0;

  // ---- Engagement Score ----
  // Benchmarks: >6% excellent, 3-6% good, 1-3% average, <1% weak.
  let engagementScore;
  if (engagementRate >= 6) engagementScore = 90 + Math.min(10, (engagementRate - 6) * 2);
  else if (engagementRate >= 3) engagementScore = 65 + ((engagementRate - 3) / 3) * 25;
  else if (engagementRate >= 1) engagementScore = 35 + ((engagementRate - 1) / 2) * 30;
  else engagementScore = engagementRate * 35;
  engagementScore = clamp(engagementScore);

  // ---- Consistency Score ----
  // Based on posting frequency (ideal 3-7 posts/week) — too sparse or too
  // spammy both reduce the score.
  let consistencyScore;
  if (postingFrequency >= 3 && postingFrequency <= 7) {
    consistencyScore = 90 + Math.min(10, (Math.min(postingFrequency, 5) - 3) * 5);
  } else if (postingFrequency > 7) {
    consistencyScore = clamp(90 - (postingFrequency - 7) * 5, 40);
  } else {
    consistencyScore = clamp(postingFrequency * 30, 0, 90);
  }
  consistencyScore = clamp(consistencyScore);

  // ---- Fake Follower Risk ----
  // Compares expected engagement (industry curve by follower count) against
  // actual engagement, and checks like:comment ratio for bot-like patterns.
  const expectedEngagementRate = expectedEngagementForFollowerCount(followers);
  const engagementGap = safeDiv(expectedEngagementRate - engagementRate, expectedEngagementRate || 1);
  const commentToLikeRatio = safeDiv(avgComments, avgLikes || 1);
  let fakeFollowerRisk = clamp(engagementGap * 100, 0, 100);
  // Extremely low comment:like ratio (<0.5%) is a common bot/purchased-followers signal.
  if (avgLikes > 0 && commentToLikeRatio < 0.005) fakeFollowerRisk = clamp(fakeFollowerRisk + 20);
  fakeFollowerRisk = clamp(fakeFollowerRisk);

  // ---- Audience Quality Score ----
  // Inverse of fake follower risk, nudged by reel-view-to-follower ratio
  // (a healthy account gets meaningful reach relative to its follower base).
  const viewToFollowerRatio = safeDiv(avgReelViews, followers);
  let audienceQualityScore = clamp(100 - fakeFollowerRisk * 0.8 + Math.min(15, viewToFollowerRatio * 30));
  audienceQualityScore = clamp(audienceQualityScore);

  // ---- Reliability Score ----
  // Driven entirely by campaign history; brand-new creators start neutral (60)
  // so they aren't unfairly excluded before they have a track record.
  let reliabilityScore = 60;
  if (performance && performance.totalCampaigns > 0) {
    reliabilityScore =
      performance.completionRate * 0.4 +
      performance.onTimeDeliveryRate * 0.35 +
      performance.acceptanceRate * 0.25;
  }
  reliabilityScore = clamp(reliabilityScore);

  // ---- Brand Friendly Score ----
  // Blends admin/brand ratings (if any) with communication reliability proxy
  // (on-time delivery) and low fake-follower risk (brand safety).
  let brandFriendlyScore = 70;
  if (performance && performance.totalCampaigns > 0) {
    const ratingComponent = ((performance.brandRatingAvg + performance.adminRatingAvg) / 2 / 5) * 100;
    brandFriendlyScore = ratingComponent * 0.6 + performance.onTimeDeliveryRate * 0.2 + (100 - fakeFollowerRisk) * 0.2;
  } else {
    brandFriendlyScore = (100 - fakeFollowerRisk) * 0.7 + consistencyScore * 0.3;
  }
  brandFriendlyScore = clamp(brandFriendlyScore);

  // ---- Growth Score ----
  // Without historical time-series data we approximate using posting
  // frequency + engagement as a proxy for momentum. Once historical
  // snapshots of InstagramProfile are tracked over time, replace this with
  // actual follower/engagement delta over the last 30/90 days.
  let growthScore = clamp(consistencyScore * 0.5 + engagementScore * 0.5);

  // ---- Composite Creator Score ----
  const creatorScore = clamp(
    engagementScore * 0.25 +
      audienceQualityScore * 0.2 +
      reliabilityScore * 0.2 +
      brandFriendlyScore * 0.15 +
      consistencyScore * 0.1 +
      growthScore * 0.1
  );

  return {
    creatorScore: round1(creatorScore),
    engagementScore: round1(engagementScore),
    consistencyScore: round1(consistencyScore),
    audienceQualityScore: round1(audienceQualityScore),
    reliabilityScore: round1(reliabilityScore),
    fakeFollowerRisk: round1(fakeFollowerRisk),
    brandFriendlyScore: round1(brandFriendlyScore),
    growthScore: round1(growthScore),
    recommendationTier: tierFromScore(creatorScore, fakeFollowerRisk),
  };
}

/** Rough industry engagement-rate curve: smaller accounts engage harder. */
function expectedEngagementForFollowerCount(followers) {
  if (followers < 10000) return 8;
  if (followers < 50000) return 5.5;
  if (followers < 200000) return 3.5;
  if (followers < 1000000) return 2.2;
  return 1.5;
}

function tierFromScore(creatorScore, fakeFollowerRisk) {
  if (fakeFollowerRisk >= 70) return "NOT_RECOMMENDED";
  if (creatorScore >= 85) return "HIGHLY_RECOMMENDED";
  if (creatorScore >= 70) return "RECOMMENDED";
  if (creatorScore >= 55) return "GOOD_CHOICE";
  if (creatorScore >= 40) return "REVIEW";
  return "NOT_RECOMMENDED";
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { computeCreatorScores, tierFromScore };
