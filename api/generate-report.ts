/**
 * api/generate-report.ts — POST /api/generate-report
 *
 * Thin handler: the report itself is generated server-side in
 * lib/report.ts (model proposes, the server disposes — every scored /
 * labeled field is validated and re-derived there).
 *
 * Carbon Pass 2, Finding 4: strict runtime type checks, and the rate
 * limit runs IMMEDIATELY after the method check — before any
 * JSON.stringify of the body — so oversized or mistyped payloads cannot
 * burn CPU or slip past validation.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { generateRentalReport, UpstreamUnavailableError } from "../lib/report.js";
import { checkRateLimit, getClientIp } from "../lib/rate-limit.js";

// Carbon Pass 1, finding #5: unauthenticated AI endpoints had no rate
// limiting and no body-size caps, so scripts could drain Gemini quota.
const RATE_LIMIT = 20; // requests per IP per window
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ANSWERS_JSON_LENGTH = 30000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Carbon Pass 2, Finding 4: rate-limit FIRST, before inspecting or
  // stringifying the body.
  if (!checkRateLimit(`generate-report:${getClientIp(req)}`, RATE_LIMIT, RATE_LIMIT_WINDOW_MS)) {
    res.status(429).json({ error: "Too many requests — please try again shortly.", retryable: true });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error("[api/generate-report] FATAL: GEMINI_API_KEY is not set");
    res.status(500).json({ error: "Server misconfiguration: missing GEMINI_API_KEY" });
    return;
  }

  const { answers } = (req.body || {}) as { answers?: unknown };

  // Carbon Pass 2, Finding 4: strict runtime types — an array is an
  // object in JS, so `typeof answers !== "object"` alone let `[]`
  // through and wasted a Gemini call.
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    res.status(400).json({ error: "Missing or invalid answers object" });
    return;
  }

  // Carbon Pass 1, finding #5: enforce a body-size cap so an oversized
  // intake payload cannot drain quota.
  if (JSON.stringify(answers).length > MAX_ANSWERS_JSON_LENGTH) {
    res.status(400).json({ error: "Answers payload exceeds the size limit." });
    return;
  }

  try {
    const report = await generateRentalReport(answers as Record<string, unknown>);
    res.status(200).json({
      structuredData: report.structuredData,
      keyFindings: report.keyFindings,
      fullReport: report.fullReport,
      reviewFlags: report.reviewFlags,
    });
  } catch (err: unknown) {
    if (err instanceof UpstreamUnavailableError) {
      console.error("[api/generate-report] Upstream unavailable:", err.message);
      res.status(503).json({
        error: "RRU is temporarily busy — please try again in a few seconds.",
        retryable: true,
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/generate-report] Report generation error:", message);
    // Carbon Pass 1, finding #5: never return raw internal exception
    // strings to clients — they leak implementation details.
    res.status(500).json({ error: "Failed to generate report" });
  }
}
