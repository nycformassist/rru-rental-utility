import { useState } from "react";
import { ChatComponent } from "./ChatComponent";

export type Message = {
  id: string;
  role: "user" | "model" | "system";
  text: string;
};

export type SubmitStatus = "idle" | "submitting" | "success" | "error";

// Matches the actual output of /api/generate-report.
export type StructuredData = {
  fullName: string;
  contactInfo: string;
  propertyInterest: string;
  homeType: string;
  preferredAreas: string;
  budgetRange: string;
  moveInTimeline: string;
  householdSize: string;
  paymentSources: string;
  documentReadiness: string;
  rentalHistory: string;
  requirementsAndPets: string;
  moveInReadinessStage: string;
  additionalNotes: string;

  scoreContactComplete?: number;
  scoreHousingRequirementsClear?: number;
  scoreMoveInTimelineClear?: number;
  scoreFinancialInformationProvided?: number;
  scorePaymentDocumentationContext?: number;
  scoreDocumentReadiness?: number;
  scorePropertyMatchInformation?: number;
  score?: number;

  statusLabel?: "Ready for Agent Review" | "Additional Information Needed" | "Inquiry Incomplete";
  statusEmoji?: "🟢" | "🟡" | "⚪";
  recommendedNextStep?: string;
  aiNarrative?: string;
  submittedAt?: string;
};

// ── Intake question definitions ──────────────────────────────────────────────
// 14 phases, one topic at a time. Field keys line up 1:1 with
// lib/constants.ts's PHASE_RULES and with what api/generate-report.ts
// reads off `answers`.
const INTAKE_QUESTIONS = [
  { phase: 1,  field: "fullName",             question: "Hi! I'll ask a few quick questions to help match you with available rentals. To start — what's your **name**?" },
  { phase: 2,  field: "contactInfo",          question: "Thanks! What's the best **phone number and/or email** to reach you at?" },
  { phase: 3,  field: "propertyInterest",     question: "Are you interested in a specific apartment or listing, a few specific ones, or just exploring what's generally available?" },
  { phase: 4,  field: "homeType",             question: "What are you looking for — a **studio, 1, 2, 3, or 4+ bedroom** apartment, or are you flexible?" },
  { phase: 5,  field: "preferredAreas",       question: "What **neighborhoods, areas, or zip codes** are you interested in?" },
  { phase: 6,  field: "budgetRange",          question: "What's your approximate **maximum monthly rent**?" },
  { phase: 7,  field: "moveInTimeline",       question: "When are you hoping to **move in**? (e.g., immediately, within 30 days, still exploring)" },
  { phase: 8,  field: "householdSize",        question: "How many people will be **living in the apartment**?" },
  { phase: 9,  field: "paymentSources",       question: "How do you expect to pay your monthly rent? (e.g., employment income, housing assistance/subsidy, or a combination — whatever applies to you)" },
  { phase: 10, field: "documentReadiness",    question: "If requested, which documents would you currently be able to provide? (e.g., ID, proof of income, bank statements — or let me know if you're not sure yet)" },
  { phase: 11, field: "rentalHistory",        question: "Have you **rented before**, and could you provide a previous landlord reference if needed?" },
  { phase: 12, field: "requirementsAndPets",  question: "Do you have any **pets**, or any important requirements like parking, laundry, elevator access, or outdoor space?" },
  { phase: 13, field: "moveInReadinessStage", question: "Where are you in your search — just starting, actively searching, ready to apply, or need to move urgently? Have you already viewed apartments, or are you working with another agent?" },
  { phase: 14, field: "additionalNotes",      question: "Last thing — is there **anything else** you'd like the agent to know about your housing search?" },
];

// ── All fields for submission guard ──────────────────────────────────────────
const ALL_FIELDS: { key: string; label: string; critical: boolean }[] = [
  { key: "fullName",             label: "Name",                    critical: true  },
  { key: "contactInfo",          label: "Contact Information",     critical: true  },
  { key: "propertyInterest",     label: "Property Interest",       critical: false },
  { key: "homeType",             label: "Home Type",               critical: false },
  { key: "preferredAreas",       label: "Preferred Areas",         critical: false },
  { key: "budgetRange",          label: "Budget Range",            critical: false },
  { key: "moveInTimeline",       label: "Move-In Timeline",        critical: false },
  { key: "householdSize",        label: "Household Size",          critical: false },
  { key: "paymentSources",       label: "Payment Sources",         critical: false },
  { key: "documentReadiness",    label: "Document Readiness",      critical: false },
  { key: "rentalHistory",        label: "Rental History",          critical: false },
  { key: "requirementsAndPets",  label: "Requirements & Pets",     critical: false },
  { key: "moveInReadinessStage", label: "Move-In Readiness",       critical: false },
  { key: "additionalNotes",      label: "Additional Notes",        critical: false },
];

// ── Defensive boolean coercion ───────────────────────────────────────────────
function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return Boolean(value);
}

// ── Client-side preflight validation ─────────────────────────────────────────
// Only Name and Contact get a hard local check — everything else is left
// to /api/evaluate, which has the real phase rule and pushback script.
function validateInputPreflight(phase: number, text: string): string | null {
  const t = text.trim();
  if (t.length === 0) return "A response is required before continuing.";
  if (t.length > 4000) return "Your response exceeds the character limit. Please summarize.";

  if (phase === 1 && t.length < 2) {
    return "Please share at least your first name so we know what to call you.";
  }

  if (phase === 2) {
    const hasEmail = /[^\s@]+@[^\s@]+\.[^\s@]+/.test(t);
    const digitCount = (t.match(/\d/g) || []).length;
    if (!hasEmail && digitCount < 7) {
      return "Please provide a valid phone number (at least 7 digits) or a valid email address.";
    }
  }

  return null;
}

// ── Fallback data builders (used only if /api/generate-report is unreachable) ─
function buildStructuredDataFallback(answers: Record<string, string>): StructuredData {
  return {
    fullName:             answers.fullName             || "",
    contactInfo:          answers.contactInfo          || "",
    propertyInterest:     answers.propertyInterest     || "",
    homeType:             answers.homeType             || "",
    preferredAreas:       answers.preferredAreas       || "",
    budgetRange:          answers.budgetRange          || "",
    moveInTimeline:       answers.moveInTimeline       || "",
    householdSize:        answers.householdSize        || "",
    paymentSources:       answers.paymentSources       || "",
    documentReadiness:    answers.documentReadiness    || "",
    rentalHistory:        answers.rentalHistory        || "",
    requirementsAndPets:  answers.requirementsAndPets  || "",
    moveInReadinessStage: answers.moveInReadinessStage || "",
    additionalNotes:      answers.additionalNotes      || "",
    score: 0,
    statusLabel: "Inquiry Incomplete",
    statusEmoji: "⚪",
    recommendedNextStep: "Manual agent review required — automated scoring failed.",
    submittedAt: new Date().toISOString(),
  };
}

function buildFallbackReport(answers: Record<string, string>): string {
  return [
    "RRU™ RENTAL INQUIRY BRIEF",
    `Generated: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET`,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "STATUS: ⚪ MANUAL REVIEW REQUIRED (automated scoring failed)",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "APPLICANT",
    `  Name:              ${answers.fullName             || "Not provided"}`,
    `  Contact:           ${answers.contactInfo          || "Not provided"}`,
    "",
    "HOUSING SEARCH",
    `  Property Interest: ${answers.propertyInterest     || "Not provided"}`,
    `  Home Type:         ${answers.homeType             || "Not provided"}`,
    `  Preferred Areas:   ${answers.preferredAreas       || "Not provided"}`,
    `  Budget Range:      ${answers.budgetRange          || "Not provided"}`,
    `  Move-In Timeline:  ${answers.moveInTimeline       || "Not provided"}`,
    "",
    "HOUSEHOLD",
    `  Occupants:         ${answers.householdSize        || "Not provided"}`,
    "",
    "FINANCIAL / PAYMENT CONTEXT",
    `  Payment Sources:   ${answers.paymentSources       || "Not provided"}`,
    "",
    "DOCUMENT & RENTAL READINESS",
    `  Document Readiness: ${answers.documentReadiness    || "Not provided"}`,
    `  Rental History:     ${answers.rentalHistory        || "Not provided"}`,
    `  Requirements/Pets:  ${answers.requirementsAndPets  || "Not provided"}`,
    `  Move-In Readiness:  ${answers.moveInReadinessStage || "Not provided"}`,
    "",
    "ADDITIONAL NOTES",
    `  ${answers.additionalNotes || "None provided."}`,
    "",
    "RECOMMENDED NEXT STEP: Manual agent review required (automated scoring failed).",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "RRU assists with information collection and inquiry organization only.",
    "It does not approve, deny, or make housing eligibility decisions.",
  ].join("\n");
}

// ── Helper: Fetch with Automatic 503 Retry ────────────────────────────────────
async function fetchWithEvaluateRetry(url: string, options: RequestInit, retries = 1, delay = 2000): Promise<Response> {
  try {
    const response = await fetch(url, options);
    if (response.status === 503 && retries > 0) {
      console.warn(`[App] Received 503 from API. Auto-retrying in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithEvaluateRetry(url, options, retries - 1, delay);
    }
    return response;
  } catch (error) {
    if (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithEvaluateRetry(url, options, retries - 1, delay);
    }
    throw error;
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    { id: "init", role: "model", text: INTAKE_QUESTIONS[0].question },
  ]);
  const [isLoading,     setIsLoading]   = useState(false);
  const [isFinished,    setIsFinished]  = useState(false);
  const [currentPhase, setCurrentPhase] = useState(1);
  const [answers,      setAnswers]     = useState<Record<string, string>>({});
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>("idle");
  const [finalScore,   setFinalScore]  = useState<StructuredData | null>(null);
  const [reviewFlags,  setReviewFlags] = useState<string[]>([]);
  const [preflightFailCount, setPreflightFailCount] = useState(0);
  const PREFLIGHT_BYPASS_THRESHOLD = 2;
  // The exact text of the last question the client actually saw — not
  // necessarily the static phase text (could be a pushback, follow-up,
  // or consistency confirmation). Sent to /api/evaluate as "question" so
  // relevance is graded against what was really asked.
  const [lastAssistantMessage, setLastAssistantMessage] = useState(INTAKE_QUESTIONS[0].question);

  const addMessage = (role: Message["role"], text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, role, text },
    ]);
  };

  const handleSendMessage = async (text: string) => {
    if (!text.trim() || isLoading || isFinished || currentPhase > INTAKE_QUESTIONS.length) return;

    const currentQuestion = INTAKE_QUESTIONS[currentPhase - 1];
    addMessage("user", text);

    const preflightError = validateInputPreflight(currentPhase, text);
    if (preflightError && preflightFailCount < PREFLIGHT_BYPASS_THRESHOLD) {
      setPreflightFailCount((n) => n + 1);
      addMessage("model", preflightError);
      return;
    }
    if (preflightError) {
      console.warn(`[App] Preflight bypassed for phase ${currentPhase} after ${preflightFailCount} local rejections.`);
    }

    setIsLoading(true);

    try {
      const response = await fetchWithEvaluateRetry("/api/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase:      currentPhase,
          question:   lastAssistantMessage,
          answer:     text.trim(),
          allAnswers: answers,
        }),
      });

      if (!response.ok) throw new Error(`Evaluation API returned ${response.status}`);

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      addMessage(
        "model",
        data.agentResponse || "Could you share a bit more so we can move forward?"
      );

      const isValid = toBool(data.isValid);
      const hasExtractedData = typeof data.extractedData === "string" && data.extractedData.trim().length > 0;
      const inconsistencyDetected = toBool(data.inconsistencyDetected);
      const followUpTriggered = toBool(data.followUpTriggered);

      const shouldAdvance =
        toBool(data.advancePhase) ||
        (isValid && hasExtractedData && !inconsistencyDetected && !followUpTriggered);

      if (isValid && hasExtractedData) {
        setAnswers((prev) => ({
          ...prev,
          [currentQuestion.field]: String(data.extractedData).trim(),
        }));
      }

      if (shouldAdvance) {
        setPreflightFailCount(0);
        const nextPhase = currentPhase + 1;

        if (nextPhase <= INTAKE_QUESTIONS.length) {
          setCurrentPhase(nextPhase);
          const agentAlreadyAskedSomething = /\?\s*$/.test(String(data.agentResponse || "").trim());
          if (!agentAlreadyAskedSomething) {
            const nextQuestion = INTAKE_QUESTIONS[nextPhase - 1];
            // If the model flagged that the client already touched on the
            // next topic (e.g. mentioned a cross-street/subway line while
            // answering a different question), lead with that instead of
            // asking cold — this is what actually fixes the "I already
            // told you that" loop, not just a cosmetic acknowledgment.
            const priorContextNote =
              typeof data.priorContextNote === "string" && data.priorContextNote.trim().length > 0
                ? data.priorContextNote.trim()
                : null;
            const nextMessageText = priorContextNote
              ? `${priorContextNote} Just to make sure I have the complete picture — ${nextQuestion.question}`
              : nextQuestion.question;
            setLastAssistantMessage(nextMessageText);
            setTimeout(() => {
              addMessage("model", nextMessageText);
            }, 450);
          } else {
            setLastAssistantMessage(String(data.agentResponse));
          }
        } else {
          setCurrentPhase(INTAKE_QUESTIONS.length + 1);
          setTimeout(() => {
            addMessage(
              "system",
              "All done! Please review your answers below. When you're ready, click **Submit Inquiry** to send your information to our team."
            );
          }, 450);
        }
      } else {
        setLastAssistantMessage(String(data.agentResponse || currentQuestion.question));
      }
    } catch (err) {
      console.error("[App] Evaluation error:", err);
      addMessage("model", "A system error occurred while evaluating your response. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleEditAnswer = (field: string, newValue: string) => {
    if (!isFinished && submitStatus !== "submitting") {
      setAnswers((prev) => ({ ...prev, [field]: newValue }));
    }
  };

  const handleFinishInterview = async () => {
    if (isLoading || isFinished || submitStatus === "submitting") return;

    const criticalMissing = ALL_FIELDS
      .filter((f) => f.critical && !answers[f.key]?.trim())
      .map((f) => f.label);

    if (criticalMissing.length > 0) {
      addMessage("system", `⚠️ Submission blocked: required fields are empty — ${criticalMissing.join(", ")}.`);
      return;
    }

    setSubmitStatus("submitting");
    setIsLoading(true);

    try {
      let structuredData: StructuredData;
      let fullReport: string;

      try {
        const reportRes = await fetch("/api/generate-report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers }),
        });

        if (!reportRes.ok) throw new Error(`Report API returned ${reportRes.status}`);
        const generated = await reportRes.json();

        structuredData = { ...generated.structuredData, submittedAt: new Date().toISOString() };
        fullReport     = generated.fullReport;
        setFinalScore(structuredData);
        setReviewFlags(Array.isArray(generated.reviewFlags) ? generated.reviewFlags : []);
      } catch (reportErr) {
        structuredData = buildStructuredDataFallback(answers);
        fullReport      = buildFallbackReport(answers);
        setFinalScore(structuredData);
        setReviewFlags([]);
      }

      const intakeRes = await fetch("/api/intake", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ structuredData, fullReport }),
      });

      const intakeData = await intakeRes.json();

      if (intakeRes.ok && intakeData.success) {
        setIsFinished(true);
        setSubmitStatus("success");
        addMessage(
          "system",
          "✅ Your inquiry has been successfully submitted! A rental specialist will review your information and reach out shortly."
        );
      } else {
        setSubmitStatus("error");
        addMessage("system", "❌ Submission failed. Please try again.");
      }
    } catch (err: unknown) {
      setSubmitStatus("error");
      addMessage("system", "❌ A network error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const roadmapSteps = [
    { title: "Name",           phase: 1 },
    { title: "Contact",        phase: 2 },
    { title: "Property",       phase: 3 },
    { title: "Home Type",      phase: 4 },
    { title: "Areas",          phase: 5 },
    { title: "Budget",         phase: 6 },
    { title: "Timeline",       phase: 7 },
    { title: "Household",      phase: 8 },
    { title: "Payment",        phase: 9 },
    { title: "Documents",      phase: 10 },
    { title: "Rental History", phase: 11 },
    { title: "Requirements",   phase: 12 },
    { title: "Readiness",      phase: 13 },
    { title: "Anything Else",  phase: 14 },
  ];

  const progressPct =
    isFinished || currentPhase > INTAKE_QUESTIONS.length
      ? 100
      : Math.round(((currentPhase - 1) / INTAKE_QUESTIONS.length) * 100);

  // Status color — never a "good/bad" color scale, just a neutral
  // completeness indicator matching the 🟢🟡⚪ operational statuses.
  const statusColors: Record<string, string> = {
    "Ready for Agent Review": "text-emerald-400",
    "Additional Information Needed": "text-amber-400",
    "Inquiry Incomplete": "text-slate-400",
  };

  return (
    <div className="flex h-screen w-full bg-slate-50 font-sans text-slate-900 overflow-hidden flex-col md:flex-row">

      <aside className="hidden md:flex w-72 bg-slate-900 text-slate-300 flex-col border-r border-slate-800 shrink-0">
        <div className="p-6 border-b border-slate-800">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
            <h1 className="font-bold text-white tracking-tight uppercase text-sm">
              RRU™ Rental Inquiry
            </h1>
          </div>
          <p className="text-[10px] text-slate-600 font-mono uppercase tracking-widest">
            Inquiry Qualification v1.0
          </p>
        </div>

        <nav className="flex-1 overflow-y-auto p-4 space-y-0.5">
          <div className="text-[10px] font-bold text-slate-600 uppercase px-2 py-2 tracking-widest">
            14-Step Intake
          </div>
          {roadmapSteps.map((step) => {
            const isActive    = currentPhase === step.phase;
            const isCompleted = currentPhase > step.phase || isFinished;
            return (
              <div
                key={step.phase}
                className={`flex items-center gap-3 px-3 py-2 text-xs transition-colors rounded ${
                  isActive ? "bg-slate-800 text-white" : isCompleted ? "text-slate-400" : "text-slate-600 opacity-40"
                }`}
              >
                <span
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] flex-shrink-0 font-mono ${
                    isActive
                      ? "bg-indigo-600 text-white font-bold"
                      : isCompleted
                      ? "bg-emerald-800 text-emerald-300"
                      : "border border-slate-700 text-slate-600"
                  }`}
                >
                  {isCompleted && !isActive ? "✓" : step.phase.toString().padStart(2, "0")}
                </span>
                <span className="font-mono">{step.title}</span>
              </div>
            );
          })}
        </nav>

        {finalScore && (
          <div className="p-4 border-t border-slate-800 bg-slate-900/50 shrink-0">
            <div className="text-[10px] uppercase font-bold text-slate-500 mb-3 tracking-widest">
              Inquiry Status
            </div>
            <div className="flex items-baseline gap-1 mb-1">
              <span className={`text-3xl font-black ${statusColors[finalScore.statusLabel || "Inquiry Incomplete"]}`}>
                {finalScore.score ?? "—"}
              </span>
              <span className="text-slate-600 text-sm font-mono">/100</span>
            </div>
            <div className={`text-xs font-bold uppercase tracking-widest mb-1 ${statusColors[finalScore.statusLabel || "Inquiry Incomplete"]}`}>
              {finalScore.statusEmoji} {finalScore.statusLabel || "Pending"}
            </div>
            {reviewFlags.length > 0 && (
              <div className="text-[11px] text-sky-400 mb-2">
                🔵 {reviewFlags.length} property-specific review item{reviewFlags.length > 1 ? "s" : ""}
              </div>
            )}
            {finalScore.recommendedNextStep && (
              <div className="text-[10px] text-slate-500 border-t border-slate-800 pt-2">
                Next: <span className="text-slate-300">{finalScore.recommendedNextStep}</span>
              </div>
            )}
          </div>
        )}

        {!finalScore && (
          <div className="p-4 border-t border-slate-800 bg-slate-900/50 shrink-0">
            <div className="flex justify-between items-center mb-2">
              <span className="text-[10px] uppercase font-bold text-slate-600 tracking-widest">Progress</span>
              <span className="text-[10px] font-mono text-slate-400">{progressPct}%</span>
            </div>
            <div className="w-full bg-slate-800 h-1 rounded-full overflow-hidden">
              <div className="bg-indigo-600 h-full transition-all duration-500" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="mt-4 text-[10px] text-slate-700 leading-relaxed font-mono">
              RRU collects and organizes inquiry information only. It does not
              approve, deny, or make housing eligibility decisions — a
              licensed agent reviews every inquiry.
            </div>
          </div>
        )}
      </aside>

      <main className="flex-1 flex flex-col relative min-w-0">
        <ChatComponent
          messages={messages}
          onSendMessage={handleSendMessage}
          onFinish={handleFinishInterview}
          isLoading={isLoading}
          isFinished={isFinished}
          submitStatus={submitStatus}
          answers={answers}
          onEditAnswer={handleEditAnswer}
          showReview={currentPhase > INTAKE_QUESTIONS.length}
          intakeQuestions={INTAKE_QUESTIONS}
          allFields={ALL_FIELDS}
        />
      </main>
    </div>
  );
}
