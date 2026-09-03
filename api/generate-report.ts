/**
 * api/generate-report.ts — POST /api/generate-report
 *
 * Generates the Rental Inquiry Brief (Gemini-driven), then validates and
 * re-derives every scored/labeled field server-side. The model proposes;
 * this handler disposes — same "rigid math" philosophy as the Buyer RRU.
 *
 * One rule here has no equivalent in the Buyer RRU and must never be
 * relaxed: a housing-assistance/subsidy mention is NEVER allowed to
 * produce a negative-sounding flag or a lower score than an equivalent
 * employment-income answer would. That's enforced here in code, not just
 * asked for in the prompt — see computeReviewFlags() below.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  CATEGORY_WEIGHTS,
  ScoreCategory,
  SCORE_CATEGORY_KEYS,
  buildReportSystemInstruction,
  inquiryStatus,
  buildFullRentalReport,
} from "../lib/constants.js";
import { generateJSON, UpstreamUnavailableError } from "../lib/gemini-client.js";

const CATEGORY_SCORE_FIELD: Record<ScoreCategory, string> = {
  contactComplete: "scoreContactComplete",
  housingRequirementsClear: "scoreHousingRequirementsClear",
  moveInTimelineClear: "scoreMoveInTimelineClear",
  financialInformationProvided: "scoreFinancialInformationProvided",
  paymentDocumentationContext: "scorePaymentDocumentationContext",
  documentReadiness: "scoreDocumentReadiness",
  propertyMatchInformation: "scorePropertyMatchInformation",
};

function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
}

const HOUSING_ASSISTANCE_KEYWORDS = /\b(section\s?8|housing choice voucher|cityfheps|fheps|hasa|voucher|subsidy|rental assistance|housing assistance)\b/i;

/**
 * Computes the 🔵 Property-Specific Review flags — informational routing
 * only, never a penalty, never phrased negatively. This is where the
 * FAIR_HOUSING_HARD_RULES prompt instruction gets a deterministic
 * backstop: even if the model's own output somehow phrased a housing-
 * assistance mention negatively, this function is the actual source of
 * truth for review flags and only ever produces the neutral wording below.
 */
function computeReviewFlags(answers: Record<string, unknown>): string[] {
  const flags: string[] = [];
  const paymentSources = String(answers.paymentSources || "");
  const propertyInterest = String(answers.propertyInterest || "").toLowerCase();

  if (HOUSING_ASSISTANCE_KEYWORDS.test(paymentSources)) {
    flags.push("Housing assistance information provided — requires standard property-specific review.");
  }
  if (propertyInterest.length > 0 && !propertyInterest.includes("general search") && propertyInterest !== "not provided") {
    flags.push("Applicant named a specific property/listing — confirm current availability and property-specific requirements.");
  }

  return flags;
}

function deriveRecommendedNextStep(statusLabel: string, reviewFlags: string[]): string {
  if (statusLabel === "Ready for Agent Review") {
    return "Contact prospect to discuss available properties matching stated requirements" +
      (reviewFlags.length > 0 ? " and address the property-specific review items below." : ".");
  }
  if (statusLabel === "Additional Information Needed") {
    return "Follow up with the applicant to complete the missing intake details noted above.";
  }
  return "Gather additional intake information before scheduling agent follow-up.";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error("[api/generate-report] FATAL: GEMINI_API_KEY is not set");
    res.status(500).json({ error: "Server misconfiguration: missing GEMINI_API_KEY" });
    return;
  }

  const { answers } = (req.body || {}) as { answers?: Record<string, unknown> };

  if (!answers || typeof answers !== "object") {
    res.status(400).json({ error: "Missing or invalid answers object" });
    return;
  }

  const systemInstruction = buildReportSystemInstruction();
  const prompt = `Generate the Rental Inquiry Brief from this intake data:\n\n${JSON.stringify(answers, null, 2)}\n\nPopulate categoryEvidence for every category BEFORE writing any numeric score. Apply all scoring rules strictly, including the housing-assistance-is-not-negative rule. Verify your arithmetic before returning. The "score" field must equal the exact sum of the 7 category scores. Return the JSON object.`;

  let parsed: Record<string, unknown>;
  try {
    const responseText = await generateJSON(systemInstruction, prompt);
    try {
      parsed = JSON.parse(responseText);
    } catch {
      console.error("[api/generate-report] Malformed model response:", responseText);
      res.status(500).json({ error: "RRU returned a malformed report response" });
      return;
    }
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
    res.status(500).json({ error: "Failed to generate report", detail: message });
    return;
  }

  if (!parsed.structuredData || !parsed.keyFindings) {
    console.error("[api/generate-report] Report missing required fields:", Object.keys(parsed));
    res.status(500).json({ error: "RRU report was incomplete" });
    return;
  }

  const sd = parsed.structuredData as Record<string, unknown>;

  // ── Rigid math: clamp every category to its weight ceiling, then
  //    recompute the total as their exact sum. ───────────────────────────
  const categoryScores = {} as Record<ScoreCategory, number>;
  for (const category of SCORE_CATEGORY_KEYS) {
    const field = CATEGORY_SCORE_FIELD[category];
    const raw = Number((sd as Record<string, unknown>)[field] ?? 0);
    const clamped = clamp(raw, CATEGORY_WEIGHTS[category]);
    categoryScores[category] = clamped;
    (sd as Record<string, unknown>)[field] = clamped;
  }

  const evidence = (sd.categoryEvidence as Record<string, unknown>) || {};
  for (const category of SCORE_CATEGORY_KEYS) {
    const ev = evidence[category];
    const hasEvidence = typeof ev === "string" && ev.trim().length > 0;
    if (!hasEvidence && categoryScores[category] > 0) {
      console.warn(`[api/generate-report] No categoryEvidence for "${category}" — forcing score to 0.`);
      categoryScores[category] = 0;
      (sd as Record<string, unknown>)[CATEGORY_SCORE_FIELD[category]] = 0;
    }
  }

  // ── Fair-housing backstop: if a housing-assistance/subsidy mention is
  //    present, financial/payment-context scores can never be lower than
  //    an equivalent employment-income answer would score. If the model
  //    under-scored these categories despite a subsidy being mentioned,
  //    float them up to at least the "complete information provided"
  //    floor rather than trust a possibly-biased model score. This is the
  //    hard enforcement layer behind FAIR_HOUSING_HARD_RULES rule #2 —
  //    the prompt asks for this, this code guarantees it.
  const paymentSourcesText = String(answers.paymentSources || "");
  if (HOUSING_ASSISTANCE_KEYWORDS.test(paymentSourcesText)) {
    const FLOOR_FRACTION = 0.85; // "complete information" floor, matching the rubric's top band threshold
    const financialFloor = Math.round(CATEGORY_WEIGHTS.financialInformationProvided * FLOOR_FRACTION);
    const paymentFloor = Math.round(CATEGORY_WEIGHTS.paymentDocumentationContext * FLOOR_FRACTION);
    if (categoryScores.financialInformationProvided < financialFloor) {
      console.warn("[api/generate-report] Fair-housing floor applied to financialInformationProvided.");
      categoryScores.financialInformationProvided = financialFloor;
      sd.scoreFinancialInformationProvided = financialFloor;
    }
    if (categoryScores.paymentDocumentationContext < paymentFloor) {
      console.warn("[api/generate-report] Fair-housing floor applied to paymentDocumentationContext.");
      categoryScores.paymentDocumentationContext = paymentFloor;
      sd.scorePaymentDocumentationContext = paymentFloor;
    }
  }

  const computedScore = SCORE_CATEGORY_KEYS.reduce((sum, c) => sum + categoryScores[c], 0);
  if (Number(sd.score) !== computedScore) {
    console.warn(`[api/generate-report] Score corrected — model returned ${sd.score}, server computed ${computedScore}.`);
  }
  sd.score = computedScore;

  // ── Derived labels — always server-computed ─────────────────────────
  const status = inquiryStatus(computedScore);
  sd.statusLabel = status.label;
  sd.statusEmoji = status.emoji;

  // ── Review flags — deterministic, never negative, never a penalty ──
  const reviewFlags = computeReviewFlags(answers);
  sd.recommendedNextStep = deriveRecommendedNextStep(status.label, reviewFlags);

  // ── Full report assembly ─────────────────────────────────────────
  const aiNarrative =
    typeof parsed.keyFindings === "string" && parsed.keyFindings.trim().length > 0
      ? parsed.keyFindings.trim()
      : "Summary unavailable — review raw intake data below.";
  sd.aiNarrative = aiNarrative;
  const fullReport = buildFullRentalReport(sd, answers, aiNarrative, reviewFlags);

  res.status(200).json({
    structuredData: sd,
    keyFindings: aiNarrative,
    fullReport,
    reviewFlags,
  });
}
