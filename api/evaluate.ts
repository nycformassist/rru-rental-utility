/**
 * api/evaluate.ts — POST /api/evaluate
 *
 * Per-phase gatekeeping for the RRU Rental Inquiry (Gemini-driven). Thin
 * handler: prompt text and phase rules live in lib/constants.ts,
 * model-calling/retry logic lives in lib/gemini-client.ts. This file
 * validates the request shape, calls generateJSON(), and recomputes
 * "advancePhase" itself rather than trusting the model's own value.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  buildEvaluateSystemInstruction,
  EVALUATE_RESPONSE_SCHEMA,
  INTAKE_QUESTIONS,
} from "../lib/constants.js";
import { generateJSON, UpstreamUnavailableError } from "../lib/gemini-client.js";
import { checkRateLimit, getClientIp } from "../lib/rate-limit.js";

// Carbon Pass 1, finding #5: unauthenticated AI endpoints had no rate
// limiting and no body-size caps, so scripts could drain Gemini quota.
const RATE_LIMIT = 20; // requests per IP per window
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ANSWER_LENGTH = 4000;
const MAX_ALL_ANSWERS_JSON_LENGTH = 30000;

interface EvaluateRequestBody {
  phase: number | string;
  question: string;
  answer: string;
  allAnswers?: Record<string, unknown>;
  language?: string;
}

interface EvaluateResult {
  isValid: boolean;
  extractedData: string | null;
  agentResponse: string;
  advancePhase: boolean;
  inconsistencyDetected: boolean;
  followUpTriggered: boolean;
  priorContextNote: string | null;
}

function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return Boolean(value);
}

const TOTAL_PHASES = 14;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error("[api/evaluate] FATAL: GEMINI_API_KEY is not set");
    res.status(500).json({ error: "Server misconfiguration: missing GEMINI_API_KEY" });
    return;
  }

  const { phase, question, answer, allAnswers, language } = (req.body || {}) as EvaluateRequestBody;

  // `question` is accepted for backward compatibility but NEVER trusted:
  // the canonical question is looked up server-side from
  // INTAKE_QUESTIONS (Carbon Pass 1, finding #5 — the client-supplied
  // question was a prompt-injection vector).
  void question;

  if (!phase || answer === undefined || answer === null) {
    res.status(400).json({ error: "Missing required fields: phase, answer" });
    return;
  }

  // Carbon Pass 1, finding #5: enforce body-size caps so oversized
  // payloads cannot drain quota or smuggle prompt content.
  const answerText = String(answer).trim();
  if (answerText.length > MAX_ANSWER_LENGTH) {
    res.status(400).json({ error: "Answer exceeds the 4000-character limit." });
    return;
  }
  if (allAnswers !== undefined && JSON.stringify(allAnswers).length > MAX_ALL_ANSWERS_JSON_LENGTH) {
    res.status(400).json({ error: "Collected answers payload exceeds the size limit." });
    return;
  }

  if (!checkRateLimit(`evaluate:${getClientIp(req)}`, RATE_LIMIT, RATE_LIMIT_WINDOW_MS)) {
    res.status(429).json({ error: "Too many requests — please try again shortly.", retryable: true });
    return;
  }

  const phaseNum = Number(phase);
  if (isNaN(phaseNum) || phaseNum < 1 || phaseNum > TOTAL_PHASES) {
    res.status(400).json({ error: "Invalid phase number" });
    return;
  }

  const lang = language === "es" ? "es" : "en";
  const canonicalQuestion = INTAKE_QUESTIONS[lang][phaseNum - 1].question;
  const systemInstruction = buildEvaluateSystemInstruction(phaseNum, lang);

  const currentDate = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });

  const prompt = `Today's date: ${currentDate}.
Language preference: ${lang === "es" ? "Spanish (Español)" : "English"}

Phase: ${phaseNum}
Question: "${canonicalQuestion}"
Client Answer: "${answerText}"
Previously Collected: ${JSON.stringify(allAnswers || {})}

Evaluate against the Phase ${phaseNum} rule, run the consistency check against Previously Collected, and run the dynamic follow-up check. Return your JSON response.`;

  try {
    const responseText = await generateJSON(systemInstruction, prompt, EVALUATE_RESPONSE_SCHEMA);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      console.error("[api/evaluate] Malformed model response:", responseText);
      res.status(500).json({ error: "RRU returned a malformed response" });
      return;
    }

    const isValid = toBool(parsed.isValid);
    const extractedData = typeof parsed.extractedData === "string" ? parsed.extractedData.trim() : "";
    const hasExtractedData = extractedData.length > 0;
    const inconsistencyDetected = toBool(parsed.inconsistencyDetected);
    const followUpTriggered = toBool(parsed.followUpTriggered);

    // Carbon Pass 1, finding #6: advancePhase is computed ONLY from the
    // validated fields. The model's own advancePhase value is NOT trusted
    // — the previous `modelAdvancePhase || (...)` formula advanced the
    // phase even when a follow-up was pending, an inconsistency was
    // detected, or no data was extracted.
    const advancePhase =
      isValid && hasExtractedData && !inconsistencyDetected && !followUpTriggered;

    const result: EvaluateResult = {
      isValid,
      extractedData: hasExtractedData ? extractedData : null,
      agentResponse:
        typeof parsed.agentResponse === "string" && parsed.agentResponse.trim().length > 0
          ? parsed.agentResponse.trim()
          : (lang === "es" ? "Gracias — ¿podría compartir un poco más para avanzar?" : "Thanks — could you share a bit more so we can move forward?"),
      advancePhase,
      inconsistencyDetected,
      followUpTriggered,
      priorContextNote:
        typeof parsed.priorContextNote === "string" && parsed.priorContextNote.trim().length > 0
          ? parsed.priorContextNote.trim()
          : null,
    };

    res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof UpstreamUnavailableError) {
      console.error("[api/evaluate] Upstream unavailable:", err.message);
      res.status(503).json({
        error: "RRU is temporarily busy — please try again in a few seconds.",
        retryable: true,
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/evaluate] Evaluation error:", message);
    // Carbon Pass 1, finding #5: never return raw internal exception
    // strings to clients — they leak implementation details.
    res.status(500).json({ error: "Failed to evaluate input" });
  }
}