import { useState } from "react";
import { ChatComponent } from "./ChatComponent";
import { INTAKE_QUESTIONS } from "../lib/constants";

export type Message = {
  id: string;
  role: "user" | "model" | "system";
  text: string;
};

export type SubmitStatus = "idle" | "submitting" | "success" | "error";
export type Language = "en" | "es";

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

const ROADMAP_TITLES: Record<Language, string[]> = {
  en: ["Name", "Contact", "Property", "Home Type", "Areas", "Budget", "Timeline", "Household", "Payment", "Documents", "Rental History", "Requirements", "Readiness", "Anything Else"],
  es: ["Nombre", "Contacto", "Propiedad", "Tipo", "Áreas", "Presupuesto", "Plazo", "Hogar", "Pago", "Documentos", "Historial", "Requisitos", "Disponibilidad", "Otros Detalles"]
};

const ALL_FIELDS = [
  { key: "fullName",             label: "Name",                 critical: true  },
  { key: "contactInfo",          label: "Contact Information",    critical: true  },
  { key: "propertyInterest",     label: "Property Interest",      critical: false },
  { key: "homeType",             label: "Home Type",              critical: false },
  { key: "preferredAreas",       label: "Preferred Areas",        critical: false },
  { key: "budgetRange",          label: "Budget Range",           critical: false },
  { key: "moveInTimeline",       label: "Move-In Timeline",       critical: false },
  { key: "householdSize",        label: "Household Size",         critical: false },
  { key: "paymentSources",       label: "Payment Sources",        critical: false },
  { key: "documentReadiness",    label: "Document Readiness",     critical: false },
  { key: "rentalHistory",        label: "Rental History",         critical: false },
  { key: "requirementsAndPets",  label: "Requirements & Pets",    critical: false },
  { key: "moveInReadinessStage", label: "Move-In Readiness",      critical: false },
  { key: "additionalNotes",      label: "Additional Notes",       critical: false },
];

function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return Boolean(value);
}

// Carbon Pass 1, finding #11: length limits are ALWAYS enforced
// (localized), regardless of preflightFailCount — the previous code
// skipped ALL validation after 2 failures, including the empty and
// oversized checks. The Phase 2 contact-format check is REMOVED from
// preflight: it blocked the LLM's designed Phase 2 pushback script
// (PHASE_RULES[2]) — the model handles a reluctant contact answer
// itself. Phase-specific format checks that remain are still subject
// to the bypass threshold.
function validateInputLength(text: string, lang: Language): string | null {
  const t = text.trim();
  if (t.length === 0)
    return lang === "es"
      ? "Se requiere una respuesta para continuar."
      : "A response is required before continuing.";
  if (t.length > 4000)
    return lang === "es"
      ? "Su respuesta excede el límite de caracteres. Por favor, resuma."
      : "Your response exceeds the character limit. Please summarize.";
  return null;
}

function validateInputPreflight(phase: number, text: string, lang: Language): string | null {
  const t = text.trim();
  if (phase === 1 && t.length < 2)
    return lang === "es"
      ? "Comparta al menos su nombre para saber cómo llamarle."
      : "Please share at least your first name so we know what to call you.";
  return null;
}

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
    `   Name:               ${answers.fullName            || "Not provided"}`,
    `   Contact:            ${answers.contactInfo         || "Not provided"}`,
    "",
    "HOUSING SEARCH",
    `   Property Interest:  ${answers.propertyInterest    || "Not provided"}`,
    `   Home Type:          ${answers.homeType            || "Not provided"}`,
    `   Preferred Areas:    ${answers.preferredAreas      || "Not provided"}`,
    `   Budget Range:       ${answers.budgetRange         || "Not provided"}`,
    `   Move-In Timeline:   ${answers.moveInTimeline      || "Not provided"}`,
    "",
    "HOUSEHOLD",
    `   Occupants:          ${answers.householdSize       || "Not provided"}`,
    "",
    "FINANCIAL / PAYMENT CONTEXT",
    `   Payment Sources:    ${answers.paymentSources      || "Not provided"}`,
    "",
    "DOCUMENT & RENTAL READINESS",
    `   Document Readiness: ${answers.documentReadiness   || "Not provided"}`,
    `   Rental History:     ${answers.rentalHistory       || "Not provided"}`,
    `   Requirements/Pets:  ${answers.requirementsAndPets || "Not provided"}`,
    `   Move-In Readiness:  ${answers.moveInReadinessStage|| "Not provided"}`,
    "",
    "ADDITIONAL NOTES",
    `   ${answers.additionalNotes || "None provided."}`,
    "",
    "RECOMMENDED NEXT STEP: Manual agent review required (automated scoring failed).",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "RRU assists with information collection and inquiry organization only.",
  ].join("\n");
}

async function fetchWithEvaluateRetry(url: string, options: RequestInit, retries = 1, delay = 2000): Promise<Response> {
  try {
    const response = await fetch(url, options);
    if (response.status === 503 && retries > 0) {
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

export default function App() {
  const [language, setLanguage] = useState<Language>("en");
  const questionsList = INTAKE_QUESTIONS[language];

  const [messages, setMessages] = useState<Message[]>([
    { id: "init", role: "model", text: INTAKE_QUESTIONS.en[0].question },
  ]);
  const [isLoading,       setIsLoading]   = useState(false);
  const [isFinished,      setIsFinished]  = useState(false);
  const [currentPhase,    setCurrentPhase] = useState(1);
  const [answers,         setAnswers]     = useState<Record<string, string>>({});
  const [submitStatus,    setSubmitStatus] = useState<SubmitStatus>("idle");
  const [finalScore,      setFinalScore]  = useState<StructuredData | null>(null);
  const [reviewFlags,     setReviewFlags] = useState<string[]>([]);
  const [preflightFailCount, setPreflightFailCount] = useState(0);
  const PREFLIGHT_BYPASS_THRESHOLD = 2;
  const [lastAssistantMessage, setLastAssistantMessage] = useState(INTAKE_QUESTIONS.en[0].question);

  const handleLanguageChange = (newLang: Language) => {
    if (currentPhase > 1 || isFinished) return;
    setLanguage(newLang);
    setMessages([{ id: "init", role: "model", text: INTAKE_QUESTIONS[newLang][0].question }]);
    setLastAssistantMessage(INTAKE_QUESTIONS[newLang][0].question);
  };

  const addMessage = (role: Message["role"], text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, role, text },
    ]);
  };

  const handleSendMessage = async (text: string) => {
    if (!text.trim() || isLoading || isFinished || currentPhase > questionsList.length) return;

    const currentQuestion = questionsList[currentPhase - 1];
    addMessage("user", text);

    const lengthError = validateInputLength(text, language);
    if (lengthError) {
      addMessage("model", lengthError);
      return;
    }

    const preflightError = validateInputPreflight(currentPhase, text, language);
    if (preflightError && preflightFailCount < PREFLIGHT_BYPASS_THRESHOLD) {
      setPreflightFailCount((n) => n + 1);
      addMessage("model", preflightError);
      return;
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
          language:   language,
        }),
      });

      if (!response.ok) throw new Error(`Evaluation API returned ${response.status}`);

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      addMessage("model", data.agentResponse || "Could you share a bit more?");

      const isValid = toBool(data.isValid);
      const hasExtractedData = typeof data.extractedData === "string" && data.extractedData.trim().length > 0;

      // Carbon Pass 1, finding #6: trust the server's advancePhase
      // directly. The server computes it from the validated fields
      // (isValid && hasExtractedData && no inconsistency / follow-up);
      // the previous client-side `||` formula re-introduced the model's
      // own value and could advance past a pending follow-up, past an
      // inconsistency, or with no extracted data at all.
      const shouldAdvance = toBool(data.advancePhase);

      if (isValid && hasExtractedData) {
        setAnswers((prev) => ({
          ...prev,
          [currentQuestion.field]: String(data.extractedData).trim(),
        }));
      }

      if (shouldAdvance) {
        setPreflightFailCount(0);
        const nextPhase = currentPhase + 1;

        if (nextPhase <= questionsList.length) {
          setCurrentPhase(nextPhase);
          // Carbon Pass 1, finding #7: ALWAYS emit the next question
          // when advancing. The previous trailing-"?" check suppressed
          // it whenever the model's acknowledgment ended in a question
          // mark, leaving the user answering one question while the
          // state machine validated it for a different field.
          const nextQuestion = questionsList[nextPhase - 1];
          const priorContextNote =
            typeof data.priorContextNote === "string" && data.priorContextNote.trim().length > 0
              ? data.priorContextNote.trim()
              : null;
          const nextMessageText = priorContextNote
            ? `${priorContextNote} ${nextQuestion.question}`
            : nextQuestion.question;
          setLastAssistantMessage(nextMessageText);
          setTimeout(() => {
            addMessage("model", nextMessageText);
          }, 450);
        } else {
          setCurrentPhase(questionsList.length + 1);
          setTimeout(() => {
            addMessage(
              "system",
              language === "es"
                ? "¡Todo listo! Por favor revise sus respuestas abajo. Cuando esté listo, haga clic en **Enviar consulta**."
                : "All done! Please review your answers below. When you're ready, click **Submit Inquiry**."
            );
          }, 450);
        }
      } else {
        setLastAssistantMessage(String(data.agentResponse || currentQuestion.question));
      }
    } catch (err) {
      console.error("[App] Evaluation error:", err);
      addMessage("model", language === "es" ? "Ocurrió un error al evaluar su respuesta. Intente de nuevo." : "A system error occurred. Please try again.");
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
      addMessage("system", `⚠️ Required fields empty: ${criticalMissing.join(", ")}.`);
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
      } catch {
        structuredData = buildStructuredDataFallback(answers);
        fullReport     = buildFallbackReport(answers);
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
        addMessage("system", "✅ Inquiry successfully submitted to management.");
      } else {
        setSubmitStatus("error");
        addMessage("system", "❌ Submission failed. Please try again.");
      }
    } catch {
      setSubmitStatus("error");
      addMessage("system", "❌ A network error occurred.");
    } finally {
      setIsLoading(false);
    }
  };

  const roadmapTitles = ROADMAP_TITLES[language];
  const progressPct =
    isFinished || currentPhase > questionsList.length
      ? 100
      : Math.round(((currentPhase - 1) / questionsList.length) * 100);

  const statusColors: Record<string, string> = {
    "Ready for Agent Review": "text-emerald-400",
    "Additional Information Needed": "text-amber-400",
    "Inquiry Incomplete": "text-slate-400",
  };

  return (
    <div className="flex h-screen w-full bg-slate-50 font-sans text-slate-900 overflow-hidden flex-col md:flex-row">
      
      {/* MOBILE HEADER BAR WITH LANGUAGE TOGGLE */}
      <div className="md:hidden bg-slate-900 text-white px-4 py-3 flex items-center justify-between border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
          <span className="font-bold tracking-tight uppercase text-xs">
            RRU™ Rental Inquiry
          </span>
        </div>
        {currentPhase === 1 && !isFinished && (
          <div className="flex gap-1 bg-slate-800 p-1 rounded">
            <button
              onClick={() => handleLanguageChange("en")}
              className={`px-2.5 py-1 text-[11px] font-mono rounded ${language === "en" ? "bg-indigo-600 text-white font-bold" : "text-slate-400"}`}
            >
              EN
            </button>
            <button
              onClick={() => handleLanguageChange("es")}
              className={`px-2.5 py-1 text-[11px] font-mono rounded ${language === "es" ? "bg-indigo-600 text-white font-bold" : "text-slate-400"}`}
            >
              ES
            </button>
          </div>
        )}
      </div>

      {/* DESKTOP SIDEBAR */}
      <aside className="hidden md:flex w-72 bg-slate-900 text-slate-300 flex-col border-r border-slate-800 shrink-0">
        <div className="p-6 border-b border-slate-800 flex justify-between items-center">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
              <h1 className="font-bold text-white tracking-tight uppercase text-sm">
                RRU™ Rental Inquiry
              </h1>
            </div>
            <p className="text-[10px] text-slate-600 font-mono uppercase tracking-widest">
              {language === "es" ? "Bilingüe / Gold" : "Gold Standard v1.0"}
            </p>
          </div>
          {currentPhase === 1 && !isFinished && (
            <div className="flex gap-1 bg-slate-800 p-1 rounded">
              <button
                onClick={() => handleLanguageChange("en")}
                className={`px-2 py-0.5 text-[10px] font-mono rounded ${language === "en" ? "bg-indigo-600 text-white" : "text-slate-400"}`}
              >
                EN
              </button>
              <button
                onClick={() => handleLanguageChange("es")}
                className={`px-2 py-0.5 text-[10px] font-mono rounded ${language === "es" ? "bg-indigo-600 text-white" : "text-slate-400"}`}
              >
                ES
              </button>
            </div>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto p-4 space-y-0.5">
          <div className="text-[10px] font-bold text-slate-600 uppercase px-2 py-2 tracking-widest">
            {language === "es" ? "Proceso de 14 Pasos" : "14-Step Intake"}
          </div>
          {roadmapTitles.map((title, idx) => {
            const stepNum = idx + 1;
            const isActive = currentPhase === stepNum;
            const isCompleted = currentPhase > stepNum || isFinished;
            return (
              <div
                key={stepNum}
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
                  {isCompleted && !isActive ? "✓" : stepNum.toString().padStart(2, "0")}
                </span>
                <span className="font-mono">{title}</span>
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
          showReview={currentPhase > questionsList.length}
          intakeQuestions={questionsList}
          allFields={ALL_FIELDS}
        />
      </main>
    </div>
  );
}