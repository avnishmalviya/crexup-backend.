/**
 * Instagram analysis service.
 *
 * Real mode: calls Meta's Instagram Graph API (requires a connected
 * Instagram Business/Creator account + a long-lived access token — the
 * Graph API cannot pull full analytics for arbitrary public accounts that
 * aren't connected to your app, so in practice most creators' deep metrics
 * (audience country/city/gender/age) will need to come from the creator
 * granting access, or be filled in manually by the admin as the spec allows).
 *
 * Mock mode (default, USE_MOCK_INSTAGRAM=true): generates realistic
 * pseudo-random profile data so the rest of the platform (scoring, search,
 * dashboards) can be built and demoed without live credentials.
 */

const useMock = process.env.USE_MOCK_INSTAGRAM !== "false";

async function analyzeInstagramProfile(instagramUsername) {
  if (useMock) return mockAnalyze(instagramUsername);
  return realAnalyze(instagramUsername);
}

async function realAnalyze(instagramUsername) {
  const token = process.env.INSTAGRAM_GRAPH_API_TOKEN;
  const baseUrl = process.env.INSTAGRAM_GRAPH_API_BASE_URL || "https://graph.facebook.com/v19.0";

  if (!token) {
    throw new Error(
      "INSTAGRAM_GRAPH_API_TOKEN is not set. Set USE_MOCK_INSTAGRAM=true to use mock data, or provide credentials."
    );
  }

  // NOTE: This endpoint shape assumes the creator has connected their IG
  // Business account and you've resolved their IG Business Account ID.
  // Swap `igBusinessAccountId` resolution for your actual OAuth/connect flow.
  const igBusinessAccountId = await resolveIgBusinessAccountId(instagramUsername, token, baseUrl);

  const fields = [
    "biography",
    "followers_count",
    "follows_count",
    "media_count",
    "profile_picture_url",
    "username",
  ].join(",");

  const res = await fetch(`${baseUrl}/${igBusinessAccountId}?fields=${fields}&access_token=${token}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Instagram Graph API error (${res.status}): ${body}`);
  }
  const profile = await res.json();

  // Media-level metrics (reel views/likes/comments) require a separate
  // /media call + insights per media item, aggregated here.
  const mediaMetrics = await fetchRecentMediaMetrics(igBusinessAccountId, token, baseUrl);

  return {
    profilePictureUrl: profile.profile_picture_url || null,
    bio: profile.biography || null,
    followers: profile.followers_count || 0,
    following: profile.follows_count || 0,
    totalPosts: profile.media_count || 0,
    avgReelViews: mediaMetrics.avgReelViews,
    avgLikes: mediaMetrics.avgLikes,
    avgComments: mediaMetrics.avgComments,
    engagementRate: mediaMetrics.engagementRate,
    postingFrequency: mediaMetrics.postingFrequency,
    accountType: "BUSINESS",
    verificationBadge: false, // Graph API does not expose the blue-check flag
    audienceCountry: null, // Requires the /insights audience_* metrics on the connected account
    audienceCity: null,
    audienceGender: null,
    audienceAge: null,
    audienceInterests: null,
    dataSource: "GRAPH_API",
    lastFetchedAt: new Date(),
    isStale: false,
  };
}

async function resolveIgBusinessAccountId(_instagramUsername, _token, _baseUrl) {
  // Placeholder: in production, look this up from your stored OAuth
  // connection for this creator (Facebook Page -> connected IG account).
  throw new Error(
    "resolveIgBusinessAccountId is not implemented — wire this to your Instagram OAuth/connect flow."
  );
}

async function fetchRecentMediaMetrics(_igBusinessAccountId, _token, _baseUrl) {
  // Placeholder aggregate — implement using /{ig-media-id}/insights with
  // metrics=reach,plays,likes,comments,saved over the last N posts.
  return {
    avgReelViews: 0,
    avgLikes: 0,
    avgComments: 0,
    engagementRate: 0,
    postingFrequency: 0,
  };
}

// ---------------------------------------------------------------------
// Mock implementation — deterministic-ish pseudo-random data seeded by
// username so repeated fetches for the same creator look stable.
// ---------------------------------------------------------------------

function seededRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h << 5) - h + seed.charCodeAt(i);
    h |= 0;
  }
  return () => {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    return h / 0x7fffffff;
  };
}

async function mockAnalyze(instagramUsername) {
  const rand = seededRandom(instagramUsername || "creator");
  const followerTiers = [3000, 12000, 45000, 150000, 600000, 2000000];
  const followers = Math.round(
    followerTiers[Math.floor(rand() * followerTiers.length)] * (0.6 + rand() * 0.8)
  );

  const engagementRate = Math.round((2 + rand() * 6) * 10) / 10; // 2% - 8%
  const avgLikes = Math.round(followers * (engagementRate / 100) * (0.7 + rand() * 0.3));
  const avgComments = Math.round(avgLikes * (0.02 + rand() * 0.05));
  const avgReelViews = Math.round(followers * (0.5 + rand() * 2.5));
  const postingFrequency = Math.round((2 + rand() * 6) * 10) / 10;
  const totalPosts = Math.round(80 + rand() * 900);
  const following = Math.round(200 + rand() * 1500);

  const countries = ["India", "United States", "UAE", "United Kingdom"];
  const genders = ["male", "female", "other"];

  return {
    profilePictureUrl: `https://i.pravatar.cc/300?u=${encodeURIComponent(instagramUsername)}`,
    bio: "Content creator | Lifestyle & Fashion | Collabs: DM",
    followers,
    following,
    totalPosts,
    avgReelViews,
    avgLikes,
    avgComments,
    engagementRate,
    postingFrequency,
    accountType: rand() > 0.5 ? "CREATOR" : "PERSONAL",
    verificationBadge: rand() > 0.85,
    audienceCountry: { [countries[0]]: 68 + rand() * 20, [countries[1]]: 5 + rand() * 10, other: 10 },
    audienceCity: { "Mumbai": 20 + rand() * 15, "Delhi": 15 + rand() * 15, "Bengaluru": 10 + rand() * 10, other: 40 },
    audienceGender: { [genders[0]]: 35 + rand() * 20, [genders[1]]: 45 + rand() * 20, [genders[2]]: 2 },
    audienceAge: { "18-24": 30 + rand() * 15, "25-34": 35 + rand() * 15, "35-44": 15, other: 10 },
    audienceInterests: { "Fashion": 40, "Travel": 25, "Fitness": 20, "Food": 15 },
    dataSource: "MOCK",
    lastFetchedAt: new Date(),
    isStale: false,
  };
}

module.exports = { analyzeInstagramProfile };
