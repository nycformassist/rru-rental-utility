/**
 * api/submit-inquiry.ts — POST /api/submit-inquiry
 *
 * The single server-side submission step for a finished Rental Inquiry.
 * Takes ONLY the collected answers ({ answers, language? }) — never
 * report content. The server generates the brief (lib/report.ts) and
 * then emails it to the agency (lib/email.ts).
 *
 * Carbon Pass 2, Finding 2: this replaces the old two-step client flow
 * (POST /api/generate-report, then POST /api/intake with the client-built
 * report). The old /api/intake accepted structuredData/fullReport
 * directly from the unauthenticated client and emailed them verbatim —
 * any attacker could POST a forged "Ready for Agent Review (Score:
 * 100/100)" report with phishing links that staff would trust because
 * it came from the agency's own sender address. That endpoint is gone;
 * the client can no longer fabricate a score, a status, or report text.
 *
 * On transient Gemini unavailability the handler returns HTTP 503
 * (retryable) so the client retries once instead of silently sending a
 * 0/100 "MANUAL REVIEW REQUIRED" fallback report (Carbon Pass 2,
 * Finding 10).
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { generateRentalReport, UpstreamUnavailableError } from "../lib/report.js";
import { isVertexConfigured } from "../lib/gemini-client.js";
import { sendInquiryEmail } from "../lib/email.js";
import { checkRateLimit, getClientIp } from "../lib/rate-limit.js";
import { submissionHash, getCachedSubmission, cacheSubmission } from "../lib/idempotency.js";

// Email is the most abuse-prone endpoint, so it gets the strictest rate
// limit (Carbon Pass 1, finding #5).
const RATE_LIMIT = 5; // requests per IP per window
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ANSWERS_JSON_LENGTH = 30000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Carbon Pass 2, Finding 4: rate-limit FIRST, before inspecting or
  // stringifying the body.
  if (!checkRateLimit(`submit-inquiry:${getClientIp(req)}`, RATE_LIMIT, RATE_LIMIT_WINDOW_MS)) {
    res.status(429).json({ success: false, error: "Too many requests — please try again shortly." });
    return;
  }

  if (!isVertexConfigured()) {
    console.error("[api/submit-inquiry] FATAL: VERTEX_SERVICE_ACCOUNT_JSON is not set");
    res.status(500).json({ success: false, error: "Server misconfiguration: missing VERTEX_SERVICE_ACCOUNT_JSON" });
    return;
  }

  const { answers, language } = (req.body || {}) as { answers?: unknown; language?: unknown };

  // Strict runtime types: only a plain answers object is accepted.
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    res.status(400).json({ success: false, error: "Missing or invalid answers object" });
    return;
  }

  if (JSON.stringify(answers).length > MAX_ANSWERS_JSON_LENGTH) {
    res.status(400).json({ success: false, error: "Answers payload exceeds the size limit." });
    return;
  }

  // DeepSeek correction — idempotency: a network retry or double-click
  // re-POSTing the same payload must not generate a second report or
  // send a duplicate email. A repeat within 10 minutes returns the
  // original successful result instead.
  const lang = language === "es" ? "es" : "en";
  const idempotencyKey = submissionHash(answers as Record<string, unknown>, lang);
  const cached = getCachedSubmission(idempotencyKey);
  if (cached) {
    res.status(200).json({ ...cached, duplicate: true });
    return;
  }

  // ── Step 1: generate the brief server-side ──────────────────────────
  let report;
  try {
    report = await generateRentalReport(answers as Record<string, unknown>);
  } catch (err: unknown) {
    if (err instanceof UpstreamUnavailableError) {
      console.error("[api/submit-inquiry] Upstream unavailable:", err.message);
      res.status(503).json({
        success: false,
        error: "RRU is temporarily busy — please try again in a few seconds.",
        retryable: true,
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/submit-inquiry] Report generation error:", message);
    res.status(500).json({ success: false, error: "Failed to generate report" });
    return;
  }

  // ── Step 2: email the server-generated brief ────────────────────────
  try {
    await sendInquiryEmail(report.structuredData, report.fullReport);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/submit-inquiry] Email error:", message);
    res.status(500).json({ success: false, error: "Failed to dispatch email." });
    return;
  }

  // Cache only after the email was actually sent — a failed attempt
  // must not block a legitimate retry.
  const responseBody: Record<string, unknown> = {
    success: true,
    message: "Inquiry submitted and emailed successfully.",
    structuredData: report.structuredData,
    reviewFlags: report.reviewFlags,
  };
  cacheSubmission(idempotencyKey, responseBody);
  res.status(200).json(responseBody);
}
