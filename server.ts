/**
 * server.ts — Local development server (RRU Rental)
 *
 * Runs Express + Vite dev middleware on a single port so that:
 * - POST /api/evaluate        →  api/evaluate.ts (Rental per-phase gatekeeping)
 * - POST /api/generate-report →  api/generate-report.ts (Rental inquiry brief)
 * - POST /api/intake          →  api/intake.ts (email delivery via Resend)
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
 * Usage:  npx tsx server.ts
 *   (requires GEMINI_API_KEY in .env; RESEND_API_KEY is required by
 *   /api/intake at request time.)
 */

import express from "express";
import type { Request, Response } from "express";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import evaluateHandler from "./api/evaluate.js";
import generateReportHandler from "./api/generate-report.js";
import intakeHandler from "./api/intake.js";

dotenv.config();

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

  if (!process.env.GEMINI_API_KEY) {
    console.error("[server] FATAL: GEMINI_API_KEY is not set in .env");
    process.exit(1);
  }

  // ── API routes — delegate to the production Vercel handlers ──────────
  app.post("/api/evaluate", vercelAdapter(evaluateHandler));
  app.post("/api/generate-report", vercelAdapter(generateReportHandler));
  app.post("/api/intake", vercelAdapter(intakeHandler));

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
