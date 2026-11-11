import React, { useState, useRef, useEffect } from "react";
import { Message, SubmitStatus, Language } from "./App";
import ReactMarkdown from "react-markdown";
import { CheckCircle2, AlertCircle, Pencil } from "lucide-react";

interface IntakeQuestion {
  field: string;
  question: string;
  phase: number;
}

interface FieldMeta {
  key: string;
  // Carbon Pass 2, Finding 8: review labels are bilingual — the Review
  // screen used to be English-only even in Spanish mode.
  label: { en: string; es: string };
  critical: boolean;
}

interface ChatComponentProps {
  messages: Message[];
  // Carbon Pass 2, Finding 8: the component did not even accept a
  // language prop — every review/footer string was hardcoded English.
  language: Language;
  onSendMessage: (text: string) => void;
  onFinish: () => void;
  isLoading: boolean;
  isFinished: boolean;
  submitStatus?: SubmitStatus;
  answers?: Record<string, string>;
  onEditAnswer?: (field: string, newValue: string) => void;
  showReview?: boolean;
  intakeQuestions?: IntakeQuestion[];
  allFields?: FieldMeta[];
}

// ── Strip internal phase markers ─────────────────────────────────────────────
function cleanMessageText(text: string): string {
  return text.replace(/^\[PHASE:\s*\d+\]\s*/i, "").trim();
}

// ── Detect error/warning system messages ─────────────────────────────────────
function isErrorMessage(text: string): boolean {
  return text.startsWith("❌") || text.startsWith("⚠️");
}

export function ChatComponent({
  messages,
  language,
  onSendMessage,
  onFinish,
  isLoading,
  isFinished,
  submitStatus,
  answers,
  onEditAnswer,
  showReview,
  intakeQuestions,
  allFields,
}: ChatComponentProps) {
  const [inputValue, setInputValue] = useState("");
  // Which review field (by key) is currently in edit mode, if any — only
  // one at a time. Click a field's value to edit it, Enter or blur to
  // save, Escape to cancel.
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const endOfMessagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (endOfMessagesRef.current) {
      endOfMessagesRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isLoading, showReview]);

  useEffect(() => {
    if (!isLoading && !isFinished && !showReview && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isLoading, isFinished, showReview]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputValue.trim();
    if (!trimmed || isLoading || isFinished || submitStatus === "submitting") return;
    onSendMessage(trimmed);
    setInputValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  const isInputDisabled =
    isLoading || isFinished || submitStatus === "submitting" || showReview;

  const reviewFields = allFields || (intakeQuestions || []).map((q) => {
    const derived = q.field.replace(/([A-Z])/g, " $1").trim();
    return {
      key: q.field,
      label: { en: derived, es: derived },
      critical: ["fullName", "contactInfo"].includes(q.field),
    };
  });

  // Carbon Pass 1, finding #9: only CRITICAL fields gate submission.
  // The previous version counted every empty field, so clearing a
  // non-critical field (e.g. "Additional Notes") permanently disabled
  // Submit with no explanation — while handleFinishInterview only ever
  // required the critical ones.
  const emptyCount = answers
    ? reviewFields.filter((f) => f.critical && !answers[f.key]?.trim()).length
    : 0;

  return (
    <div className="flex flex-col h-full w-full bg-slate-50 relative">

      {/* Header - Rebranded to RRU™ */}
      <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 md:px-8 z-10 shrink-0">
        <div className="flex items-center gap-4">
          <div className="px-2 py-1 bg-indigo-100 text-indigo-700 rounded text-[10px] font-bold uppercase tracking-wider">
            RRU™ Online
          </div>
          <div className="h-4 w-px bg-slate-200 hidden sm:block" />
          <span className="text-sm font-medium text-slate-600 underline underline-offset-4 decoration-indigo-500 hidden sm:inline">
            Automated Rental Inquiry Qualification
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-xs font-bold text-white">
            CL
          </div>
          <span className="text-xs font-semibold hidden sm:inline text-slate-700">Client</span>
        </div>
      </header>

      {/* Messages */}
      <section className="flex-1 overflow-y-auto p-4 md:p-8 flex flex-col gap-4 min-h-0">
        {/* 1. Standard Chat Messages */}
        {messages.filter(m => m.role !== "system").map((msg) => {
          const displayText = msg.role === "model" ? cleanMessageText(msg.text) : msg.text;

          return (
            <div
              key={msg.id}
              className={`flex gap-3 max-w-2xl ${
                msg.role === "user" ? "self-end flex-row-reverse" : "self-start"
              }`}
            >
              <div
                className={`w-8 h-8 rounded flex-shrink-0 flex items-center justify-center text-[10px] font-bold text-white ${
                  msg.role === "user" ? "bg-blue-600" : "bg-slate-900"
                }`}
              >
                {/* Avatar Initial changed to RRU for Real Estate Readiness Utility */}
                {msg.role === "user" ? "CL" : "RRU"}
              </div>
              <div
                className={`p-4 rounded-xl shadow-sm max-w-[calc(100%-3rem)] ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white rounded-tr-sm"
                    : "bg-white border border-slate-200 text-slate-800 rounded-tl-sm"
                }`}
              >
                {msg.role === "model" ? (
                  <ReactMarkdown
                    components={{
                      p: ({ ...props }) => (
                        <p className="text-sm leading-relaxed text-slate-800 m-0 pb-2 last:pb-0" {...props} />
                      ),
                      strong: ({ ...props }) => (
                        <strong className="font-semibold text-slate-900" {...props} />
                      ),
                    }}
                  >
                    {displayText}
                  </ReactMarkdown>
                ) : (
                  <p className="text-sm leading-relaxed text-white m-0 whitespace-pre-wrap">
                    {displayText}
                  </p>
                )}
              </div>
            </div>
          );
        })}

        {/* 2. Loading indicator */}
        {(isLoading || submitStatus === "submitting") && (
          <div className="flex gap-3 max-w-2xl self-start">
            <div className="w-8 h-8 rounded bg-slate-900 flex-shrink-0 flex items-center justify-center">
              <span className="text-[10px] font-bold text-white">RRU</span>
            </div>
            <div className="bg-white border border-slate-200 p-4 rounded-xl rounded-tl-sm shadow-sm flex items-center gap-3">
              <div className="flex gap-1">
                <div className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
              <span className="text-[11px] text-slate-400 font-medium italic">
                {submitStatus === "submitting"
                  ? language === "es"
                    ? "Finalizando su resumen de consulta..."
                    : "Finalizing your rental inquiry brief..."
                  : language === "es"
                    ? "RRU™ está analizando..."
                    : "RRU™ is analyzing..."}
              </span>
            </div>
          </div>
        )}

        {/* 3. Review Block */}
        {showReview && answers && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 max-w-3xl self-center mx-auto w-full mt-2 mb-2">
            <div className="flex items-center gap-2 mb-2 pb-3 border-b border-slate-100">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">
                {language === "es" ? "Revise su consulta de alquiler" : "Review Your Rental Inquiry"}
              </h3>
            </div>
            
            {/* Dynamic Review Table */}
            <div className="mt-4 space-y-3">
              {reviewFields.map((field) => {
                const answer = answers[field.key] || "";
                const isEditing = editingField === field.key;
                const canEdit = Boolean(onEditAnswer) && !isFinished && submitStatus !== "submitting";

                const startEdit = () => {
                  if (!canEdit) return;
                  setEditDraft(answer);
                  setEditingField(field.key);
                };
                const saveEdit = () => {
                  onEditAnswer?.(field.key, editDraft.trim());
                  setEditingField(null);
                };
                const cancelEdit = () => setEditingField(null);

                return (
                  <div key={field.key} className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 py-2 border-b border-slate-50 last:border-0">
                    <div className="sm:w-48 text-xs font-semibold text-slate-500 uppercase tracking-wider shrink-0 mt-0.5">
                      {field.label[language]}
                      {field.critical && <span className="text-red-400 ml-1" title="Required">*</span>}
                    </div>
                    <div className="flex-1">
                      {isEditing ? (
                        <textarea
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              saveEdit();
                            } else if (e.key === "Escape") {
                              cancelEdit();
                            }
                          }}
                          rows={2}
                          // Carbon Pass 2, Finding 9: cap review edits so
                          // a pasted block cannot exceed the server caps.
                          maxLength={1500}
                          className="w-full text-sm text-slate-800 border border-indigo-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-200 resize-y"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={startEdit}
                          disabled={!canEdit}
                          className={`w-full text-left group flex items-start gap-2 rounded-md px-1 -mx-1 py-0.5 ${
                            canEdit ? "hover:bg-slate-50 cursor-text" : "cursor-default"
                          }`}
                        >
                          {answer ? (
                            <span className="text-sm text-slate-800 whitespace-pre-wrap">{answer}</span>
                          ) : (
                            <span className="text-sm text-slate-400 italic">{language === "es" ? "No proporcionado" : "Not provided"}</span>
                          )}
                          {canEdit && (
                            <Pencil className="w-3 h-3 text-slate-300 group-hover:text-slate-500 shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-6 pt-4 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-3">
              <p className="text-[10px] text-slate-400 italic">
                {language === "es"
                  ? "Al enviar, confirma que la información anterior es correcta. Será revisada por nuestro equipo de alquileres — RRU no aprueba, niega ni toma decisiones de elegibilidad."
                  : "By submitting, you confirm the above information is accurate. This will be reviewed by our rental team — RRU does not approve, deny, or make eligibility decisions."}
              </p>
              <button
                type="button"
                onClick={onFinish}
                // Carbon Pass 1, finding #10: also disable while a review
                // field is being edited — otherwise clicking Submit in the
                // same cycle as the edit's onBlur submits the STALE
                // answers object and the final edit is silently omitted.
                disabled={isLoading || isFinished || submitStatus === "submitting" || emptyCount > 0 || editingField !== null}
                className="px-6 py-3 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-lg uppercase tracking-widest disabled:opacity-50 transition-colors shadow-sm whitespace-nowrap"
              >
                {isFinished
                  ? language === "es"
                    ? "✅ Enviada"
                    : "✅ Submitted"
                  : language === "es"
                    ? "Enviar consulta →"
                    : "Submit Inquiry →"}
              </button>
            </div>
          </div>
        )}

        {/* 4. System Messages (Banners) - Moved Below Review */}
        {messages.filter(m => m.role === "system").map((msg) => {
          const displayText = msg.text;
          const isError = isErrorMessage(displayText);
          
          return (
            <div key={msg.id} className="self-center mx-auto max-w-2xl w-full px-2">
              <div
                className={`flex items-start gap-2.5 text-xs font-medium px-4 py-2.5 rounded-lg border ${
                  isError
                    ? "text-red-700 bg-red-50 border-red-200"
                    : "text-slate-600 bg-slate-100 border-slate-200"
                }`}
              >
                {isError
                  ? <AlertCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                  : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />
                }
                <ReactMarkdown
                  components={{
                    p: ({ ...props }) => <p className="m-0 leading-relaxed" {...props} />,
                    strong: ({ ...props }) => <strong className="font-bold" {...props} />,
                  }}
                >
                  {displayText}
                </ReactMarkdown>
              </div>
            </div>
          );
        })}

        <div ref={endOfMessagesRef} className="h-2 shrink-0" />
      </section>

      {/* Input Footer */}
      <footer className="p-4 md:p-5 bg-white border-t border-slate-200 shrink-0">
        <form onSubmit={handleSubmit} className="flex items-center gap-3">
          <div
            className={`flex-1 flex bg-slate-50 border rounded-lg overflow-hidden transition-all ${
              isInputDisabled
                ? "border-slate-200 opacity-60"
                : "border-slate-300 focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-transparent"
            }`}
          >
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isInputDisabled}
              placeholder={
                isFinished
                  ? language === "es"
                    ? "Consulta completa."
                    : "Inquiry complete."
                  : language === "es"
                    ? "Escriba su respuesta aquí..."
                    : "Type your response here..."
              }
              // Carbon Pass 2, Finding 9: cap chat answers at 1,500
              // characters so the payload stays under the server caps.
              maxLength={1500}
              className="flex-1 bg-transparent px-4 py-3 text-sm outline-none disabled:cursor-not-allowed"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="submit"
              disabled={!inputValue.trim() || isInputDisabled}
              className="px-5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold uppercase tracking-widest disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {language === "es" ? "Enviar" : "Send"}
            </button>
          </div>
        </form>
        <div className="mt-2.5 flex justify-between items-center">
          <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-medium uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
            Rental Inquiry Protocol
          </div>
          <span className="text-[10px] text-slate-300">RRU™ Engine v1.0</span>
        </div>
      </footer>
    </div>
  );
}