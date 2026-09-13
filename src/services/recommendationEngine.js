/**
 * Ranks creators for a specific campaign context (niche, location, language)
 * on top of their baseline CreatorScore. Used when the admin selects
 * creators for a campaign — surfaces the ⭐ badge shown in the UI spec.
 */

const TIER_LABELS = {
  HIGHLY_RECOMMENDED: "⭐⭐⭐⭐⭐ Highly Recommended",
  RECOMMENDED: "⭐⭐⭐⭐ Recommended",
  GOOD_CHOICE: "⭐⭐ Good Choice",
  REVIEW: "⚠ Review Before Selecting",
  NOT_RECOMMENDED: "❌ Not Recommended",
};

function daysSince(date) {
  if (!date) return Infinity;
  return (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * @param {Array} creators - creators with `scores`, `instagramProfile`, `performance` included
 * @param {object} campaignContext - { niche, category, state, language }
 * @returns creators sorted best-first, each annotated with matchScore/tier/label
 */
function rankCreatorsForCampaign(creators, campaignContext = {}) {
  return creators
    .map((creator) => {
      const scores = creator.scores || {};
      const instagram = creator.instagramProfile || {};

      let matchScore = scores.creatorScore || 0;

      // Niche / category match
      if (campaignContext.niche && creator.contentNiche === campaignContext.niche) matchScore += 6;
      if (campaignContext.category && creator.contentCategory === campaignContext.category) matchScore += 4;

      // Location match
      if (campaignContext.state && creator.state === campaignContext.state) matchScore += 5;

      // Language match
      if (campaignContext.language && creator.language === campaignContext.language) matchScore += 5;

      // Recent activity bonus/penalty (based on last Instagram data refresh, as a proxy)
      const staleDays = daysSince(instagram.lastFetchedAt);
      if (staleDays < 14) matchScore += 3;
      else if (staleDays > 90) matchScore -= 5;

      // Fake follower risk penalty (hard cap)
      if ((scores.fakeFollowerRisk || 0) >= 70) matchScore -= 25;

      matchScore = Math.max(0, Math.min(100, Math.round(matchScore * 10) / 10));

      const tier = deriveTier(matchScore, scores.fakeFollowerRisk || 0);

      return {
        ...creator,
        recommendation: {
          matchScore,
          tier,
          label: TIER_LABELS[tier],
        },
      };
    })
    .sort((a, b) => b.recommendation.matchScore - a.recommendation.matchScore);
}

function deriveTier(matchScore, fakeFollowerRisk) {
  if (fakeFollowerRisk >= 70) return "NOT_RECOMMENDED";
  if (matchScore >= 85) return "HIGHLY_RECOMMENDED";
  if (matchScore >= 70) return "RECOMMENDED";
  if (matchScore >= 55) return "GOOD_CHOICE";
  if (matchScore >= 40) return "REVIEW";
  return "NOT_RECOMMENDED";
}

module.exports = { rankCreatorsForCampaign, TIER_LABELS };
