/**
 * api/evaluate.ts — POST /api/evaluate
 *
 * Per-phase gatekeeping for the RRU Rental Inquiry (Gemini-driven). Thin
 * handler: prompt text and phase rules live in lib/constants.ts,
 * model-calling/retry logic lives in lib/gemini-client.ts. This file
 * validates the request shape, calls generateJSON(), and recomputes
 * "advancePhase" itself rather than trusting the model's own value —
 * same fix applied to the Buyer RRU after a real production bug where a
 * model-trusted advancePhase silently desynced from the conversation.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildEvaluateSystemInstruction, EVALUATE_RESPONSE_SCHEMA } from "../lib/constants.js";
import { generateJSON, UpstreamUnavailableError } from "../lib/gemini-client.js";

interface EvaluateRequestBody {
  phase: number | string;
  question: string;
  answer: string;
  allAnswers?: Record<string, unknown>;
}

interface EvaluateResult {
  isValid: boolean;
  extractedData: string | null;
  agentResponse: string;
  advancePhase: boolean;
  inconsistencyDetected: boolean;
  followUpTriggered: boolean;
  /** Short acknowledgment of already-given info relevant to the NEXT
   *  phase's question, so the app can weave it into that question
   *  instead of asking cold — fixes the "I already told you that" loop. */
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

  const { phase, question, answer, allAnswers } = (req.body || {}) as EvaluateRequestBody;

  if (!phase || !question || answer === undefined || answer === null) {
    res.status(400).json({ error: "Missing required fields: phase, question, answer" });
    return;
  }

  const phaseNum = Number(phase);
  if (isNaN(phaseNum) || phaseNum < 1 || phaseNum > TOTAL_PHASES) {
    res.status(400).json({ error: "Invalid phase number" });
    return;
  }

  const systemInstruction = buildEvaluateSystemInstruction(phaseNum);

  const currentDate = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });

  const prompt = `Today's date: ${currentDate}.

Phase: ${phaseNum}
Question: "${question}"
Client Answer: "${String(answer).trim()}"
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
    const modelAdvancePhase = toBool(parsed.advancePhase);

    // Self-correcting advancePhase: computed from isValid + extractedData +
    // the two legitimate hold-back flags, not trusted directly from the
    // model's own field. See api/evaluate.ts in the Buyer RRU for the
    // original incident this pattern fixes.
    const advancePhase =
      modelAdvancePhase ||
      (isValid && hasExtractedData && !inconsistencyDetected && !followUpTriggered);

    if (modelAdvancePhase !== advancePhase) {
      console.warn(
        `[api/evaluate] Corrected advancePhase: model said ${modelAdvancePhase}, server computed ${advancePhase} ` +
          `(isValid=${isValid}, hasExtractedData=${hasExtractedData}, inconsistencyDetected=${inconsistencyDetected}, followUpTriggered=${followUpTriggered}).`
      );
    }

    const result: EvaluateResult = {
      isValid,
      extractedData: hasExtractedData ? extractedData : null,
      agentResponse:
        typeof parsed.agentResponse === "string" && parsed.agentResponse.trim().length > 0
          ? parsed.agentResponse.trim()
          : "Thanks — could you share a bit more so we can move forward?",
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
    res.status(500).json({ error: "Failed to evaluate input", detail: message });
  }
}
