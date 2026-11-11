# RRU Rental Inquiry — Development Log

## 2026-11-11 — Gemini 4 Carbon code-tightening passes
- **Pass 1 (11 findings, 3 critical):** non-existent Gemini model names
  (100% failure on every evaluate/report call); `server.ts` was the
  wrong app entirely (LIRU 10-phase Personal Injury legal gatekeeper);
  scoring rubric omitted category point scales. Plus XSS in intake
  emails, unauthenticated endpoints, `||` instead of `&&` in
  `advancePhase`, a trailing-`?` state-machine desync, a fair-housing
  score floor, a review-screen Submit trap, an onBlur race, and a
  Spanish preflight bypass.
- **Pass 1 fixes (branch `carbon-pass-1-fixes`, commit `912a568`):**
  env-based model names with 404 failover; `server.ts` rewritten as a
  thin dev server delegating to the real handlers; rubric MAX ceilings +
  strict response schema; HTML-escaped intake email + env-var
  recipient/sender; per-IP rate limiting + body caps + server-side
  question lookup; server-computed `advancePhase`; next question always
  emitted; fair-housing floor gated on doc context; Submit gated only on
  critical fields; Submit disabled while editing; length limits always
  enforced (localized).
- **Pass 2 (verification + 11 new findings):** 5 of the 11 Pass 1 fixes
  verified, 1 verified with a regression (Phase 9 subsidy follow-up
  overwrote `paymentSources`), 5 incomplete/broken. New: local dev
  workflow broken; `/api/intake` was an unauthenticated arbitrary-content
  email endpoint (phishing vector); rate-limit bypass via
  `X-Forwarded-For` spoofing; type-confusion crashes; vercel.json
  catch-all masking missing API routes; Phase 9 subsidy overwrite;
  fair-housing floor still triggering with zero context; incomplete
  Spanish localization; review edits bypassing length caps; retry
  latency exceeding the Vercel Hobby timeout; legacy LIRU artifacts.
- **Pass 2 fixes (same branch):** lazy model names + `err.status`-first
  extraction; `npm run dev` now runs `tsx server.ts` with dotenv loaded
  before imports (`.env.local` then `.env`); report generation + email
  merged into a single server-side `POST /api/submit-inquiry`
  (`/api/intake` deleted); rate limit checked first with
  Vercel-trusted IP headers + capped buckets; strict runtime type checks
  in all handlers; Phase 9 follow-up combines prior + new detail;
  documentation floor gated on specifics in `paymentSources`; full
  Spanish localization of the review/submit UI; 1,500-char caps on chat
  input + review edits; 2 attempts per model + `maxDuration: 30`;
  legacy cleanup (dead deps, watermark CSS, LIRU logs, Vertex script).

## Environment variables
- `GEMINI_API_KEY` (Google AI Studio Developer API — NOT Vertex AI)
- `RESEND_API_KEY`
- `INTAKE_RECIPIENT_EMAIL`, `INTAKE_FROM_EMAIL`
- Optional: `GEMINI_MODEL_NAME` (default `gemini-2.5-flash`),
  `GEMINI_FALLBACK_MODEL_NAME` (default `gemini-2.0-flash`)
