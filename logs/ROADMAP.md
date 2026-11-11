# RRU Rental Inquiry — Roadmap

## Current status
Bilingual (English / Español) 14-step rental inquiry assistant.
Live at rru-rental-utility.vercel.app. Pricing: $499 + $149/mo.

## How it works
1. Conversational intake (14 phases, Gemini-driven per-phase
   gatekeeping in `api/evaluate.ts`).
2. Server-side brief generation with rigid scoring math
   (`lib/report.ts`, `POST /api/generate-report`).
3. Single server-side submission (`POST /api/submit-inquiry`):
   the server generates the brief and emails it to the agency
   (`lib/email.ts`, Resend). The client never fabricates report content.

## Completed
- [x] 14-phase bilingual intake with fair-housing guardrails
- [x] Readiness scoring (100-point weighted model, 7 categories)
- [x] Server-side report generation + email dispatch
- [x] Per-IP rate limiting, body caps, strict runtime type checks
- [x] Carbon Pass 1 + Pass 2 code-tightening reviews and fixes

## Upcoming
- [ ] Merge `carbon-pass-1-fixes` to main (owner approval) and deploy
- [ ] End-to-end Preview verification (intake flow + email arrival)
- [ ] Verify `GEMINI_API_KEY` covers Preview scope on Vercel
      (it was Production-only, which stalled the Preview intake at
      Phase 1)
- [ ] Consider edge-level protection (Vercel Firewall / Turnstile) if
      abuse becomes a real problem — the in-memory rate limiter is
      per-function-instance only
