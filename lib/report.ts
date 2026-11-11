/**
 * lib/report.ts — server-side Rental Inquiry Brief generation.
 *
 * Shared core for POST /api/generate-report and POST /api/submit-inquiry.
 * The model proposes; this module disposes — every scored/labeled field
 * is validated and re-derived server-side ("rigid math").
 *
 * Carbon Pass 2, Finding 2: report generation lives ONLY on the server.
 * The client never fabricates a report (structuredData / fullReport /
 * score) and never sends report content to an email endpoint — the
 * phishing vector in the old /api/intake is gone with it.
 *
 * One rule here has no equivalent in the Buyer RRU and must never be
 * relaxed: a housing-assistance/subsidy mention is NEVER allowed to
 * produce a negative-sounding flag or a lower score than an equivalent
 * employment-income answer would. That's enforced here in code, not just
 * asked for in the prompt — see computeReviewFlags() below.
 */

import {
  CATEGORY_WEIGHTS,
  ScoreCategory,
  SCORE_CATEGORY_KEYS,
  REPORT_RESPONSE_SCHEMA,
  buildReportSystemInstruction,
  inquiryStatus,
  buildFullRentalReport,
} from "./constants.js";
import { generateJSON, UpstreamUnavailableError } from "./gemini-client.js";

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

export const HOUSING_ASSISTANCE_KEYWORDS = /\b(section\s?8|housing choice voucher|cityfheps|fheps|hasa|voucher|subsidy|rental assistance|housing assistance)\b/i;

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

export interface GeneratedReport {
  structuredData: Record<string, unknown>;
  keyFindings: string;
  fullReport: string;
  reviewFlags: string[];
}

/**
 * Generates the Rental Inquiry Brief from the collected intake answers.
 * Throws UpstreamUnavailableError when Gemini is temporarily unavailable
 * (callers map that to HTTP 503); throws Error for malformed/incomplete
 * model output (callers map that to HTTP 500).
 */
export async function generateRentalReport(answers: Record<string, unknown>): Promise<GeneratedReport> {
  const systemInstruction = buildReportSystemInstruction();
  const prompt = `Generate the Rental Inquiry Brief from this intake data:\n\n${JSON.stringify(answers, null, 2)}\n\nPopulate categoryEvidence for every category BEFORE writing any numeric score. Apply all scoring rules strictly, including the housing-assistance-is-not-negative rule. Verify your arithmetic before returning. The "score" field must equal the exact sum of the 7 category scores. Return the JSON object.`;

  let parsed: Record<string, unknown>;
  // Carbon Pass 1, finding #3: pass the strict report response schema
  // so the model is constrained to the exact field types.
  const responseText = await generateJSON(systemInstruction, prompt, REPORT_RESPONSE_SCHEMA);
  try {
    parsed = JSON.parse(responseText);
  } catch {
    console.error("[report] Malformed model response:", responseText);
    throw new Error("RRU returned a malformed report response");
  }

  if (!parsed.structuredData || !parsed.keyFindings) {
    console.error("[report] Report missing required fields:", Object.keys(parsed));
    throw new Error("RRU report was incomplete");
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
      console.warn(`[report] No categoryEvidence for "${category}" — forcing score to 0.`);
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
  //
  //    Carbon Pass 1, finding #8: the paymentDocumentationContext floor
  //    must NOT apply when no documentation context was actually
  //    provided. Rule #2 says subsidy income is scored EQUIVALENTLY to
  //    employment income — not automatically awarded 85% on documentation
  //    context when the applicant left Phase 10 blank or gave no
  //    voucher/program details. The financialInformationProvided floor
  //    still applies on a subsidy mention (that IS the stated income);
  //    the documentation-context floor applies only when documentation
  //    context was actually provided.
  //
  //    Carbon Pass 2, Finding 7: the Pass 1 gate was still flawed —
  //    categoryEvidence.paymentDocumentationContext is REQUIRED by the
  //    schema, so the model always writes *something* there (e.g. "No
  //    program or documentation context provided"), making any non-empty
  //    check true and firing the 13-point floor with zero context. The
  //    floor is now gated on ACTUAL documentation/program specifics in
  //    paymentSources. Without specifics, the partial-band floor is 8
  //    (rubric: "payment source stated but no documentation context").
  const paymentSourcesText = String(answers.paymentSources || "");
  if (HOUSING_ASSISTANCE_KEYWORDS.test(paymentSourcesText)) {
    const FLOOR_FRACTION = 0.85; // "complete information" floor, matching the rubric's top band threshold
    const financialFloor = Math.round(CATEGORY_WEIGHTS.financialInformationProvided * FLOOR_FRACTION);
    const paymentFloor = Math.round(CATEGORY_WEIGHTS.paymentDocumentationContext * FLOOR_FRACTION);
    if (categoryScores.financialInformationProvided < financialFloor) {
      console.warn("[report] Fair-housing floor applied to financialInformationProvided.");
      categoryScores.financialInformationProvided = financialFloor;
      sd.scoreFinancialInformationProvided = financialFloor;
    }
    const SPECIFIC_PROGRAM_OR_DOC =
      /\b(section\s?8|housing choice voucher|cityfheps|fheps|hasa|letter|packet|approved|documentation|paperwork)\b/i;
    const partialFloor = 8; // rubric: "8 = payment source stated but no documentation context"
    const targetPaymentFloor = SPECIFIC_PROGRAM_OR_DOC.test(paymentSourcesText) ? paymentFloor : partialFloor;
    if (categoryScores.paymentDocumentationContext < targetPaymentFloor) {
      console.warn("[report] Fair-housing floor applied to paymentDocumentationContext.");
      categoryScores.paymentDocumentationContext = targetPaymentFloor;
      sd.scorePaymentDocumentationContext = targetPaymentFloor;
    }
  }

  const computedScore = SCORE_CATEGORY_KEYS.reduce((sum, c) => sum + categoryScores[c], 0);
  if (Number(sd.score) !== computedScore) {
    console.warn(`[report] Score corrected — model returned ${sd.score}, server computed ${computedScore}.`);
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

  return {
    structuredData: sd,
    keyFindings: aiNarrative,
    fullReport,
    reviewFlags,
  };
}

// Re-exported so callers can distinguish a capacity problem (503) from a
// configuration/content problem (500) without importing the client.
export { UpstreamUnavailableError };
