/**
 * server.ts — Local development server (RRU Rental)
 *
 * Runs Express + Vite dev middleware on a single port so that:
 * - POST /api/evaluate        →  api/evaluate.ts (Rental per-phase gatekeeping)
 * - POST /api/generate-report →  api/generate-report.ts (Rental inquiry brief)
 * - POST /api/submit-inquiry  →  api/submit-inquiry.ts (report + email, server-side)
 * - Everything else           →  served by Vite (React SPA with HMR)
 *
 * The route handlers are the SAME modules Vercel runs in production
 * (api/*.ts) — this file only adapts Express req/res to the Vercel
 * handler signature and serves the Vite dev middleware. No intake
 * logic, prompts, or scoring lives here.
 *
 * Carbon Pass 1, finding #2: the previous server.ts was the LIRU /
 * Fortress Legal Systems 10-phase Personal Injury legal gatekeeper, not
 * the 14-phase RRU Rental utility — local dev could not run the actual
 * Rental flow at all. All LIRU/PI code was deleted in that fix.
 *
 * Carbon Pass 2, Finding 1: `import "./lib/env.js"` MUST stay the first
 * import — in Node ESM, static imports evaluate before top-level code,
 * so dotenv has to run before the api/*.ts -> lib/constants.js chain is
 * evaluated, or .env values are silently ignored.
 *
 * Carbon Pass 2, Finding 2: /api/intake is gone. Report generation and
 * email dispatch now happen together in /api/submit-inquiry so the
 * client can never hand the server arbitrary report content to email.
 *
 * Usage:  npm run dev        (tsx server.ts)
 *   (requires VERTEX_SERVICE_ACCOUNT_JSON in .env.local or .env;
 *   RESEND_API_KEY is required by /api/submit-inquiry at request time.)
 */

// MUST be first: loads .env.local / .env before any other module evaluates.
import "./lib/env.js";
import express from "express";
import type { Request, Response } from "express";
import { createServer as createViteServer } from "vite";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isVertexConfigured } from "./lib/gemini-client.js";
import evaluateHandler from "./api/evaluate.js";
import generateReportHandler from "./api/generate-report.js";
import submitInquiryHandler from "./api/submit-inquiry.js";

const PORT = process.env.PORT || 5173;

type VercelHandler = (req: VercelRequest, res: VercelResponse) => Promise<void>;

// The api/*.ts handlers only touch req.method / req.body and
// res.status().json() — all present on Express req/res — so a cast is
// sufficient. No request/response translation is needed.
function vercelAdapter(handler: VercelHandler) {
  return (req: Request, res: Response): Promise<void> =>
    handler(req as unknown as VercelRequest, res as unknown as VercelResponse);
}

async function main() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // No hard exit when the Vertex service account is missing: the API
  // handlers fail closed per request (500 "Server misconfiguration:
  // missing VERTEX_SERVICE_ACCOUNT_JSON"), so the SPA and the rest of
  // the dev server still run for testing without the credential.
  if (!isVertexConfigured()) {
    console.warn("[server] WARNING: VERTEX_SERVICE_ACCOUNT_JSON is not set in .env.local or .env — /api/evaluate, /api/generate-report and /api/submit-inquiry will return 500 until it is set.");
  }

  // ── API routes — delegate to the production Vercel handlers ──────────
  app.post("/api/evaluate", vercelAdapter(evaluateHandler));
  app.post("/api/generate-report", vercelAdapter(generateReportHandler));
  app.post("/api/submit-inquiry", vercelAdapter(submitInquiryHandler));

  // ── Vite dev middleware ───────────────────────────────────────────────
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });

  app.use(vite.middlewares);

  app.listen(PORT, () => {
    console.log(`\n   ✅   RRU Rental dev server running at http://localhost:${PORT}\n`);
  });
}

main().catch((err) => {
  console.error("Failed to start dev server:", err);
  process.exit(1);
});
