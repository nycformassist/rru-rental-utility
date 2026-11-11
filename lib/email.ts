/**
 * lib/email.ts — server-side dispatch of the Rental Inquiry Brief.
 *
 * Carbon Pass 2, Finding 2: the email is sent ONLY from server-generated
 * content. The old POST /api/intake accepted structuredData/fullReport
 * directly from the unauthenticated client and emailed them verbatim —
 * any attacker could POST a forged "Ready for Agent Review (Score:
 * 100/100)" report with phishing links that staff would trust because
 * it came from the agency's own sender address. That endpoint is gone.
 * The only caller is POST /api/submit-inquiry, which generates the
 * report server-side (lib/report.ts) and hands the result here.
 */

import { Resend } from "resend";

let resendClient: Resend | null = null;
function getResendClient(): Resend {
  if (!resendClient) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is not set");
    }
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

// Carbon Pass 1, finding #4: the recipient and sender MUST come from
// environment variables. The previous hardcoded values sent tenant PII
// to a personal Gmail, and the hardcoded onboarding@resend.dev sender
// only delivers to the Resend account owner's inbox (Resend sandbox
// restriction) — production delivery to a real agency inbox fails with
// 403. Both are required: fail closed with a clear 500 rather than
// silently emailing the wrong inbox.
function getNotificationRecipient(): string {
  const v = process.env.INTAKE_RECIPIENT_EMAIL;
  if (!v || v.trim().length === 0) {
    throw new Error("INTAKE_RECIPIENT_EMAIL is not set");
  }
  return v.trim();
}

function getSenderAddress(): string {
  const v = process.env.INTAKE_FROM_EMAIL;
  if (!v || v.trim().length === 0) {
    throw new Error("INTAKE_FROM_EMAIL is not set");
  }
  return v.trim();
}

// Escape every interpolated value before it goes into the HTML email.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sends the server-generated inquiry brief to the agency inbox.
 * `structuredData` and `fullReport` must come from generateRentalReport
 * — never from a client request body. Throws on missing configuration
 * or on a Resend rejection; callers map that to HTTP 500.
 */
export async function sendInquiryEmail(
  structuredData: Record<string, unknown>,
  fullReport: string
): Promise<void> {
  const recipient = getNotificationRecipient();
  const sender = getSenderAddress();

  const statusEmoji = String(structuredData.statusEmoji || "⚪");
  const statusLabel = String(structuredData.statusLabel || "Inquiry Incomplete");
  const applicantName = String(structuredData.fullName || "New Rental Inquiry");

  const client = getResendClient();
  const { error } = await client.emails.send({
    from: sender,
    to: [recipient],
    // Carbon Pass 1, finding #4: strip CR/LF from the subject so a
    // crafted applicant name cannot inject extra mail headers.
    subject: `[RRU™ Rental] ${statusEmoji} ${statusLabel}: ${applicantName}`.replace(/[\r\n]+/g, " "),
    text: fullReport,
    html: `
      <div style="font-family: monospace; white-space: pre-wrap; font-size: 14px; color: #333; background-color: #f8fafc; padding: 20px; border-radius: 8px;">
        <p><strong>Status:</strong> ${escapeHtml(statusEmoji)} ${escapeHtml(statusLabel)}</p>
        <p><strong>Recommended Next Step:</strong> ${escapeHtml(String(structuredData.recommendedNextStep || "Review manually"))}</p>
        <hr style="border-color:#e2e8f0; margin: 12px 0;" />
        ${escapeHtml(fullReport)}
      </div>
    `,
  });

  if (error) {
    console.error("[email] Resend error:", error);
    throw new Error("Failed to dispatch email.");
  }
}
