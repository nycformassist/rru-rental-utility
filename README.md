# RRU™ Rental Inquiry

A bilingual (English / Español) 14-step rental inquiry assistant for New
York City renters. It collects applicant information conversationally,
scores inquiry readiness (0–100), and emails a Rental Inquiry Brief to
the agency — with hard fair-housing guardrails: a housing subsidy or
lawful assistance program is never a negative signal and is scored
exactly like employment income.

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies:
   `npm install`
2. Set the environment variables in `.env.local` (takes precedence) or
   `.env`:

   | Variable | Required for | Notes |
   |---|---|---|
   | `VERTEX_SERVICE_ACCOUNT_JSON` | AI evaluation + report generation | Google Cloud service-account JSON (the whole JSON object, one line). Same value as Inner Temple's. The app talks to **Vertex AI**, not the Gemini Developer API / AI Studio — `GEMINI_API_KEY` is no longer used. |
   | `VERTEX_PROJECT_ID` | AI evaluation + report generation | Optional. Defaults to `inner-temple-514402`. |
   | `VERTEX_LOCATION` | AI evaluation + report generation | Optional. Defaults to `global`. |
   | `RESEND_API_KEY` | Email dispatch | Resend API key. |
   | `INTAKE_RECIPIENT_EMAIL` | Email dispatch | Agency inbox that receives the inquiry brief. |
   | `INTAKE_FROM_EMAIL` | Email dispatch | Sender address. On a Resend account with no verified domain, use the sandbox sender `onboarding@resend.dev` (delivers only to the account owner's inbox). |

   Optional model overrides: `GEMINI_MODEL_NAME` (default
   `gemini-2.5-flash`), `GEMINI_FALLBACK_MODEL_NAME` (default
   `gemini-2.0-flash`). The model names must exist on Vertex AI for the
   configured project/region; a 404 on the primary falls back to the
   secondary model.
3. Run the app:
   `npm run dev`

   This starts the Express + Vite dev server (`server.ts`) at
   http://localhost:5173 with the real API routes (`/api/evaluate`,
   `/api/generate-report`, `/api/submit-inquiry`).

## How submission works

The client sends ONLY the collected answers to
`POST /api/submit-inquiry`. The server generates the brief
(`lib/report.ts`) and emails it (`lib/email.ts`). The client never
fabricates report content — that closed the phishing vector where an
unauthenticated caller could email forged reports to staff.

## Deploy

Deploy to Vercel (`vercel.json`): the SPA fallback excludes `/api/`, so
a missing API route returns 404 JSON instead of 200 HTML. API functions
run with `maxDuration: 30`. Set the environment variables in
the Vercel project (Preview and Production scopes as needed) —
`VERTEX_SERVICE_ACCOUNT_JSON` is the credential that makes the AI
calls work; without it the API routes fail closed with a clear
"not configured" error.
