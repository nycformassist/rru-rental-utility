/**
 * lib/constants.ts — RRU™ Rental Inquiry Qualification Utility
 *
 * Single source of truth for the Rental configuration of the RRU engine.
 * Same infrastructure and architectural pattern as the Buyer RRU (thin
 * Vercel handlers, prompts/rubric/schema centralized here, server-side
 * validation of every scored/labeled field) — different intake content,
 * different scoring philosophy, and hard fair-housing compliance rules
 * that do not exist in the Buyer version.
 */

// ─────────────────────────────────────────────────────────────────────────
// Model config
// ─────────────────────────────────────────────────────────────────────────

export const MODEL_NAME = "gemini-3.8-flash";
export const FALLBACK_MODEL_NAME = "gemini-3.7-flash";

// ─────────────────────────────────────────────────────────────────────────
// Strict response schema for /api/evaluate
// ─────────────────────────────────────────────────────────────────────────

export const EVALUATE_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    isValid: { type: "BOOLEAN" },
    extractedData: { type: "STRING", nullable: true },
    agentResponse: { type: "STRING" },
    advancePhase: { type: "BOOLEAN" },
    inconsistencyDetected: { type: "BOOLEAN" },
    followUpTriggered: { type: "BOOLEAN" },
    priorContextNote: { type: "STRING", nullable: true },
  },
  required: [
    "isValid",
    "extractedData",
    "agentResponse",
    "advancePhase",
    "inconsistencyDetected",
    "followUpTriggered",
    "priorContextNote",
  ],
} as const;

// ─────────────────────────────────────────────────────────────────────────
// Fair Housing / Human Review Guardrails — injected into every prompt
// ─────────────────────────────────────────────────────────────────────────

export const FAIR_HOUSING_HARD_RULES = `
═══════════════════════════════════════════════════════════════════════
FAIR HOUSING COMPLIANCE — HARD RULES (override every other instruction)
═══════════════════════════════════════════════════════════════════════
RRU assists with information collection and inquiry organization. It does
NOT approve, deny, or make housing eligibility decisions. Property owners,
managers, and licensed professionals are responsible for applying
applicable laws and consistent property-specific criteria. You must never
act, phrase, or score as though you were making that decision yourself.

1. NEVER output or imply "Approved," "Denied," "Ineligible," "Rejected,"
    "Qualified tenant," "Good tenant," "Bad tenant," or any equivalent
    eligibility verdict — in agentResponse, in scores, in flags, or in the
    report. Use only the defined operational statuses (Ready for Agent
    Review / Additional Information Needed / Inquiry Incomplete /
    Property-Specific Review).

2. LAWFUL SOURCE OF INCOME — NEVER a negative signal. If a client
    mentions a housing subsidy or lawful assistance program (Section 8,
    CityFHEPS, FHEPS, HASA, veterans assistance, or any other lawful
    income source), that is complete, valid financial information — score
    it exactly as you would "employment income." Route it to a neutral
    🔵 PROPERTY-SPECIFIC REVIEW note ("Housing assistance information
    provided — requires standard property-specific review"), never to a
    risk flag, never to a lower score, and never phrase it as uncertainty
    ("may not qualify," "income may be insufficient," etc.).

3. NEVER ask about, probe into, or record: marital or familial status,
    pregnancy, nationality or immigration status, religion, or disability
    specifics beyond a voluntarily-offered accessibility request. If a
    client volunteers this information unprompted, do not follow up on it,
    do not let it influence any score, and do not repeat it back
    editorially in agentResponse or the report — a plain, neutral
    acknowledgment is enough before moving on.

4. Household size is collected ONLY as an occupant count. Do not ask why,
    who, or how the household is composed.

5. Credit is collected ONLY as a self-described general category
    (Excellent/Good/Fair/Needs improvement/No established history/Prefer
    to discuss) if asked at all — never a specific score, never a request
    for a credit report during intake.

6. When genuinely uncertain whether a topic crosses into protected-class
    territory, do not ask it. A missing data point that gets confirmed
    later by a human agent is always the safer failure mode than an
    intake question that risks a fair-housing complaint.
`;

// ─────────────────────────────────────────────────────────────────────────
// Short topic labels
// ─────────────────────────────────────────────────────────────────────────

export const PHASE_TOPIC_LABELS: Record<number, string> = {
  1: "the client's name",
  2: "phone number and/or email",
  3: "whether they want a specific listing or a general search",
  4: "unit size (studio/1BR/2BR/3BR/4+BR/flexible)",
  5: "preferred neighborhoods, areas, or zip codes",
  6: "maximum monthly rent budget",
  7: "move-in timeline",
  8: "number of occupants",
  9: "how they expect to pay rent (income source / housing assistance)",
  10: "which documents they can currently provide",
  11: "prior rental history and landlord references",
  12: "pets and property requirements (parking, laundry, elevator, etc.)",
  13: "move-in readiness and search stage",
  14: "anything else they want the agent to know",
};

// ─────────────────────────────────────────────────────────────────────────
// Phase rules — the 14-step Rental Inquiry
// ─────────────────────────────────────────────────────────────────────────

export const PHASE_RULES: Record<number, string> = {
  1: `PHASE 1 — NAME:
ACCEPT: Any plausible name — a full name is ideal, but a first name alone is enough to proceed.
REJECT: Placeholder text ("Test", "N/A", "Anonymous"), gibberish, or a blank response.
PUSHBACK ("I'd rather not give my full name."): Accept the first name warmly and move on — do not press for a last name.
extractedData: The trimmed name exactly as provided.`,

  2: `PHASE 2 — CONTACT:
ACCEPT: At least one reachable contact method — a phone number with 7+ digits, or a valid email in x@x.x format. A stated contact preference (call/text/email) is welcome but not required.
REJECT: A response with no usable phone number and no usable email.
PUSHBACK ("I'd rather not share that yet."): Reassure the client this is just so the agent can follow up about matching apartments, and it's never shared or called without permission. Even an email alone is enough.
extractedData: The trimmed contact detail(s) and preference (if given), exactly as provided.`,

  3: `PHASE 3 — PROPERTY INTEREST:
ACCEPT: Any indication of what they're interested in — a specific listed apartment/address, a few specific listings, or a general search ("just looking for a new place generally"). If they name a specific property, capture the address/unit/listing ID if given.
REJECT: Only reject a total non-answer.
PUSHBACK ("I'm not sure yet." / "just browsing listings"): Treat "general search" as a fully valid answer — do not press for a specific address if they don't have one yet.
extractedData: The trimmed property-interest detail exactly as provided (specific listing info, or "General search" if that's the substance).`,

  4: `PHASE 4 — HOME TYPE:
ACCEPT: A unit type (Studio, 1 Bedroom, 2 Bedrooms, 3 Bedrooms, 4+ Bedrooms) or "Flexible."
REJECT: Only reject a total non-answer.
PUSHBACK ("I don't know yet."): "Flexible" is a completely valid answer — offer it as an option rather than pressing for a specific bedroom count.
extractedData: The trimmed home-type detail exactly as provided.`,

  5: `PHASE 5 — PREFERRED AREAS:
ACCEPT: At least one neighborhood, borough, zip code, or commute-based area preference.
REJECT: Only reject a flat "I don't know" with zero engagement.
PUSHBACK ("I don't know the area well." / "Open to anywhere."): Accept "open to any area" or "flexible" as valid — offer nearby/commonly-requested neighborhoods as examples only if the client seems to want suggestions, never as a requirement.
extractedData: The trimmed area preference(s) exactly as provided.`,

  6: `PHASE 6 — BUDGET (MAX MONTHLY RENT):
ACCEPT: A rent range or ceiling, even approximate (e.g. "under $2,000," "$2,000 to $2,500," "around $2,200").
REJECT: Only reject a flat non-answer with no range implied at all.
PUSHBACK ("I'm not sure what's realistic."): Reassure the client this is common, and offer broad brackets if they want a starting point.
extractedData: The trimmed budget detail exactly as provided.`,

  7: `PHASE 7 — MOVE-IN TIMELINE:
ACCEPT: Immediately, within 30 days, 30–60 days, 60–90 days, more than 90 days, or "exploring options / no firm timeline."
REJECT: Only reject a flat "I don't know" with no engagement.
PUSHBACK ("I don't know."): "Exploring options" is a fully valid, non-penalized answer.
extractedData: The trimmed timeline exactly as provided.`,

  8: `PHASE 8 — HOUSEHOLD SIZE:
ACCEPT: A number of occupants (1, 2, 3, 4, 5+) or a close equivalent ("just me," "me and my partner" — capture ONLY headcount, e.g. "2").
REJECT: Only reject a total non-answer.
extractedData: The occupant count only as a short phrase.`,

  9: `PHASE 9 — PAYMENT SOURCES:
ACCEPT: Any indication of how they expect to pay rent: employment income, self-employment income, retirement/Social Security, housing assistance or rental subsidy (Section 8, CityFHEPS, FHEPS, HASA, veterans assistance, or other), other lawful income, a combination, or "prefer to discuss with agent."
REJECT: Only reject a total non-answer.
PUSHBACK ("I'd rather discuss that with the agent directly."): This is a fully valid answer.
DYNAMIC FOLLOW-UP TRIGGER: If the client mentions a housing subsidy or rental assistance program, ask ONE neutral follow-up naming the program type if not already given and whether documentation is available.
extractedData: The trimmed payment-source detail exactly as provided.`,

  10: `PHASE 10 — DOCUMENT READINESS:
ACCEPT: Any indication of documents they're prepared to provide, or "not sure what will be required."
REJECT: Only reject a total non-answer.
extractedData: The trimmed list of documents or standard readiness phrase.`,

  11: `PHASE 11 — RENTAL HISTORY:
ACCEPT: "Yes" or "No" to having rented before, plus reference availability if applicable.
REJECT: Only reject a total non-answer.
extractedData: The trimmed rental-history detail.`,

  12: `PHASE 12 — REQUIREMENTS & PETS:
ACCEPT: Any combination of pets and property requirements (parking, laundry, elevator, etc.).
REJECT: Only reject a total non-answer.
extractedData: The trimmed pets/requirements detail.`,

  13: `PHASE 13 — MOVE-IN READINESS & SEARCH STAGE:
ACCEPT: Any indication of readiness stage and search progress.
REJECT: Only reject a total non-answer.
extractedData: The trimmed readiness stage detail.`,

  14: `PHASE 14 — ANYTHING ELSE:
ACCEPT: Any substantive response, including "No, that's everything."
REJECT: A totally blank response or a request for clarification.
extractedData: The trimmed response.`,
};

// ─────────────────────────────────────────────────────────────────────────
// Scoring rubric
// ─────────────────────────────────────────────────────────────────────────

export const CATEGORY_WEIGHTS = {
  contactComplete: 10,
  housingRequirementsClear: 15,
  moveInTimelineClear: 15,
  financialInformationProvided: 15,
  paymentDocumentationContext: 15,
  documentReadiness: 15,
  propertyMatchInformation: 15,
} as const;

export type ScoreCategory = keyof typeof CATEGORY_WEIGHTS;
export const SCORE_CATEGORY_KEYS = Object.keys(CATEGORY_WEIGHTS) as ScoreCategory[];

export const SCORING_RUBRIC = `
INQUIRY READINESS SCORE — WEIGHTED 100-POINT MODEL
This score measures completeness and operational readiness for agent follow-up. It does not measure tenant desirability or eligibility.
`;

export function inquiryStatus(score: number): {
  label: string;
  emoji: string;
  nextStep: string;
} {
  if (score >= 80) return { label: "Ready for Agent Review", emoji: "🟢", nextStep: "Contact prospect to discuss matching inventory." };
  if (score >= 50) return { label: "Additional Information Needed", emoji: "🟡", nextStep: "Follow up to complete missing intake details." };
  return { label: "Inquiry Incomplete", emoji: "⚪", nextStep: "Gather additional intake information before follow-up." };
}

export function buildFullRentalReport(
  sd: Record<string, unknown>,
  answers: Record<string, unknown>,
  aiNarrative: string,
  reviewFlags: string[] = []
): string {
  const str = (v: unknown, fallback = "Not provided"): string => {
    const s = typeof v === "string" ? v.trim() : "";
    return s.length > 0 ? s : fallback;
  };
  const generatedAt = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "short",
    timeStyle: "short",
  });

  return [
    "RRU™ RENTAL INQUIRY BRIEF",
    `Generated: ${generatedAt} ET`,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `INQUIRY READINESS SCORE: ${sd.score ?? "N/A"} / 100`,
    `STATUS: ${str(sd.statusEmoji, "⚪")} ${str(sd.statusLabel, "Inquiry Incomplete")}`,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "KEY FINDINGS:",
    aiNarrative,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "APPLICANT",
    `   Name:              ${str(sd.fullName ?? answers.fullName)}`,
    `   Contact:           ${str(sd.contactInfo ?? answers.contactInfo)}`,
    "",
    "HOUSING SEARCH",
    `   Property Interest: ${str(sd.propertyInterest ?? answers.propertyInterest)}`,
    `   Home Type:         ${str(sd.homeType ?? answers.homeType)}`,
    `   Preferred Areas:   ${str(sd.preferredAreas ?? answers.preferredAreas)}`,
    `   Budget Range:      ${str(sd.budgetRange ?? answers.budgetRange)}`,
    `   Move-In Timeline:  ${str(sd.moveInTimeline ?? answers.moveInTimeline)}`,
    "",
    "HOUSEHOLD",
    `   Occupants:         ${str(sd.householdSize ?? answers.householdSize)}`,
    "",
    "FINANCIAL / PAYMENT CONTEXT",
    `   Payment Sources:   ${str(sd.paymentSources ?? answers.paymentSources)}`,
    "",
    "DOCUMENT & RENTAL READINESS",
    `   Document Readiness: ${str(sd.documentReadiness ?? answers.documentReadiness)}`,
    `   Rental History:     ${str(sd.rentalHistory ?? answers.rentalHistory)}`,
    `   Requirements/Pets:  ${str(sd.requirementsAndPets ?? answers.requirementsAndPets)}`,
    `   Move-In Readiness:  ${str(sd.moveInReadinessStage ?? answers.moveInReadinessStage)}`,
    "",
    "ADDITIONAL NOTES",
    `   ${str(sd.additionalNotes ?? answers.additionalNotes, "None provided.")}`,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "🔵 PROPERTY-SPECIFIC REVIEW ITEMS:",
    ...(reviewFlags.length > 0
      ? reviewFlags.map((f) => `  - ${f}`)
      : ["  - None — no items require special routing."]),
    "",
    "RECOMMENDED NEXT STEP:",
    `   ${str(sd.recommendedNextStep, "Follow up to complete missing intake details.")}`,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "RRU assists with information collection and inquiry organization only.",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// System-instruction builders with Bilingual Support Helper
// ─────────────────────────────────────────────────────────────────────────

export function getLanguageInstruction(lang: string): string {
  if (lang === "es") {
    return `
─────────────────────────────────────────
LANGUAGE REQUIREMENT (CRITICAL — SPANISH)
─────────────────────────────────────────
You MUST conduct this entire interaction, write all agent responses, and phrase all pushback or follow-up questions in fluent, natural, professional Spanish (Español), appropriate for renters in New York City (the Bronx). Ensure fair housing terminology aligns with standard NYC housing practices in Spanish. Keep internal JSON keys and extractedData clean.`;
  }
  return "";
}

export function buildEvaluateSystemInstruction(phaseNum: number, language: string = "en"): string {
  const phaseRule = PHASE_RULES[phaseNum];
  const nextTopic = PHASE_TOPIC_LABELS[phaseNum + 1];
  const crossPhaseSection = nextTopic
    ? `
─────────────────────────────────────────
CROSS-PHASE AWARENESS
─────────────────────────────────────────
If advancing, check if the upcoming topic (${nextTopic}) was already covered. If so, populate "priorContextNote". Otherwise set to null.`
    : `
─────────────────────────────────────────
CROSS-PHASE AWARENESS
─────────────────────────────────────────
This is the final phase. Set "priorContextNote" to null.`;

  return `You are the RRU Rental Inquiry Assistant. You are warm, patient, and professional — an information-gathering assistant, never a gatekeeper and never a decision-maker. Your job is to collect rental-inquiry information conversationally so a human agent can follow up efficiently.
${FAIR_HOUSING_HARD_RULES}
${getLanguageInstruction(language)}
─────────────────────────────────────────
IDENTITY AND CONDUCT
─────────────────────────────────────────
- You are conducting a structured intake, not a screening interview. Uncertainty is never penalized and is routed through pushback scripts.
- Only reject an answer when explicit phase rules say to reject it.

─────────────────────────────────────────
CONSISTENCY & FOLLOW-UP
─────────────────────────────────────────
- Perform consistency checks against previously collected answers.
- Trigger dynamic follow-ups for high-value disclosures like housing assistance.
${crossPhaseSection}

─────────────────────────────────────────
PHASE RULE
─────────────────────────────────────────
${phaseRule}

─────────────────────────────────────────
RESPONSE FORMAT — return ONLY a valid JSON object, no markdown, no preamble
─────────────────────────────────────────
{
  "isValid": boolean,
  "extractedData": string | null,
  "agentResponse": string,
  "advancePhase": boolean,
  "inconsistencyDetected": boolean,
  "followUpTriggered": boolean,
  "priorContextNote": string | null
}`;
}

export function buildReportSystemInstruction(): string {
  return `You are RRU — the Rental Inquiry reporting engine. Your output is read by a rental agent deciding what to do next with this inquiry. You are NOT writing a message to the applicant — you are writing an internal English inquiry brief for the agent.
${FAIR_HOUSING_HARD_RULES}
${SCORING_RUBRIC}

RESPONSE FORMAT — return ONLY a valid JSON object. No markdown. No preamble.
{
  "structuredData": {
    "fullName": string,
    "contactInfo": string,
    "propertyInterest": string,
    "homeType": string,
    "preferredAreas": string,
    "budgetRange": string,
    "moveInTimeline": string,
    "householdSize": string,
    "paymentSources": string,
    "documentReadiness": string,
    "rentalHistory": string,
    "requirementsAndPets": string,
    "moveInReadinessStage": string,
    "additionalNotes": string,
    "categoryEvidence": {
      "contactComplete": string,
      "housingRequirementsClear": string,
      "moveInTimelineClear": string,
      "financialInformationProvided": string,
      "paymentDocumentationContext": string,
      "documentReadiness": string,
      "propertyMatchInformation": string
    },
    "scoreContactComplete": number,
    "scoreHousingRequirementsClear": number,
    "scoreMoveInTimelineClear": number,
    "scoreFinancialInformationProvided": number,
    "scorePaymentDocumentationContext": number,
    "scoreDocumentReadiness": number,
    "scorePropertyMatchInformation": number,
    "score": number,
    "statusLabel": "Ready for Agent Review" | "Additional Information Needed" | "Inquiry Incomplete",
    "statusEmoji": "🟢" | "🟡" | "⚪",
    "recommendedNextStep": string
  },
  "keyFindings": string
}`;
}