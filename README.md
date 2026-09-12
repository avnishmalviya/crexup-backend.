# Crexup Backend — AI Influencer Marketing Platform

Backend for Crexup: Node.js + Express + PostgreSQL (Prisma ORM). Admin-only
dashboard; creators and brands interact only through public, no-login forms.
Instagram analysis and WhatsApp sending are **mocked by default** so you can
run and demo the whole pipeline without live API credentials — flip two env
vars to switch to the real APIs once you have them.

## 1. Setup

```bash
npm install
cp .env.example .env
# edit .env: set DATABASE_URL to your Postgres instance, set JWT_SECRET
```

Generate the Prisma client and run the first migration (needs network access
to Prisma's engine binaries — this sandbox couldn't reach them, so do this
on your own machine/CI):

```bash
npx prisma generate
npx prisma migrate dev --name init
npm run seed        # creates the first SUPER_ADMIN (admin@crexup.com / ChangeMe123!)
```

Start the server:

```bash
npm run dev          # auto-restart on change
# or
npm start
```

Health check: `GET http://localhost:4000/health`

## 2. Architecture

```
prisma/schema.prisma   Full data model (creators, Instagram data, AI scores,
                        campaigns + pipeline, WhatsApp log, shipments,
                        content submissions, performance, notes, admins)
src/
  app.js               Express app + route mounting
  server.js             Boot entry point
  lib/prisma.js         Prisma client singleton
  lib/ids.js             Human-friendly ID generators (CRX-000123, CMP-000045)
  middleware/auth.js      JWT auth guard (admin-only)
  middleware/errorHandler.js
  services/
    scoringEngine.js       Computes all 7 AI creator scores (0-100)
    recommendationEngine.js Ranks creators for a specific campaign (⭐ badges)
    instagramService.js     Instagram Graph API client + mock fallback
    whatsappService.js      WhatsApp Business API client + mock fallback
  routes/
    public.routes.js       No-login: creator registration, campaign
                            confirmation, content submission, brand inquiry
    auth.routes.js          Admin login (JWT)
    creators.routes.js      Smart search/filter, profile, notes, manual
                            Instagram override, refresh-from-API
    campaigns.routes.js     Create campaign, AI recommendations, shortlist,
                            per-creator pipeline status transitions
    whatsapp.routes.js      Preview/edit/send (individual + bulk), status
                            tracking, webhook receiver for delivery/read
                            receipts
    shipping.routes.js      Shipment tracking + shipping-sheet data
    content.routes.js       Approve / reject / request revision
    performance.routes.js   Enter/import campaign metrics (views, reach, etc.)
    dashboard.routes.js     Admin dashboard summary stats
    reports.routes.js       Campaign report — JSON, Excel (.xlsx), PDF export
```

## 3. Key design decisions

- **Everything admin-mediated.** There is no creator or brand login. Public
  routes under `/api/public/*` require no auth; every other route requires
  a Bearer JWT from `/api/auth/login`.
- **Scoring is transparent, not a black box.** `scoringEngine.js` uses
  documented heuristic formulas (engagement benchmarks by follower tier,
  posting-frequency sweet spot, like:comment ratio for bot detection, etc.)
  so you can explain any score to a brand, and can swap in a trained model
  later without touching the rest of the app — just keep the same return
  shape (`creatorScore`, `engagementScore`, ... `recommendationTier`).
- **Instagram + WhatsApp are pluggable.** `USE_MOCK_INSTAGRAM` and
  `USE_MOCK_WHATSAPP` (default `true`) swap between mock data/sending and
  real Graph API / WhatsApp Business API calls. The real-mode functions are
  stubbed with clear `throw`/TODO markers where you'll need to wire your
  own OAuth/connect flow (Instagram Graph API can't pull full analytics for
  an arbitrary public account — it needs the account connected to your Meta
  app, or the admin fills in metrics manually, which the spec explicitly
  allows for).
- **Creator performance is a rollup, not manual entry.** Marking a
  `CampaignCreator` as `COMPLETED` triggers `rollUpCreatorPerformance()`,
  which recomputes `CreatorPerformance` from all campaign history and then
  recalculates that creator's AI scores — so reliability/brand-friendly
  scores always reflect real track record.
- **Recommendation vs. base score are different things.** `CreatorScore` is
  a creator's general quality score. `recommendationEngine.js` takes that
  score and adjusts it for a *specific* campaign's niche/location/language
  match — this is what powers the ⭐⭐⭐⭐⭐ badges when shortlisting.

## 4. Not yet built (next steps)

- **Frontend** (Next.js 15 + Tailwind + shadcn/ui) — the admin dashboard,
  smart search UI, campaign pipeline board, WhatsApp composer, and the
  three public forms (registration, confirmation, content submission) plus
  the brand inquiry form.
- **File uploads** (profile pictures, screenshots, reference videos) via
  Supabase Storage — routes currently accept URLs; wire an upload endpoint
  that pushes to Supabase and returns the URL.
- **Real Instagram OAuth/connect flow** — needed before `instagramService.js`
  real mode can resolve a creator's IG Business Account ID.
- **WhatsApp template approval** — Meta requires pre-approved message
  templates for the *first* outbound message in a 24h window; the current
  `buildCampaignMessage` produces free-form text suitable for mock mode and
  for replies within an open session, but you'll need a registered template
  for the initial campaign invite in production.
- **Database migration + seed run** — requires network access to Prisma's
  engine binaries and a live Postgres instance, both unavailable in the
  sandbox this was built in.

## 5. Auth flow for admin routes

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@crexup.com","password":"ChangeMe123!"}'
# -> { "token": "...", "admin": {...} }

curl http://localhost:4000/api/dashboard/summary \
  -H "Authorization: Bearer <token>"
```
