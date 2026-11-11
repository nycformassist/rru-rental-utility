/**
 * api/intake.ts — POST /api/intake
 *
 * Emails the finished Rental Inquiry Brief to the agency. Same Vercel
 * Node handler convention as api/evaluate.ts and api/generate-report.ts.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Resend } from "resend";
import { checkRateLimit, getClientIp } from "../lib/rate-limit.js";

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

// Carbon Pass 1, finding #4: escape every interpolated value before it
// goes into the HTML email. fullReport, status fields, and
// recommendedNextStep all originate in the unauthenticated POST body —
// unescaped, any caller could inject arbitrary HTML / phishing links
// into mail opened by leasing staff.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Carbon Pass 1, finding #5: email is the most abuse-prone endpoint
// (open spam relay), so it gets the strictest rate limit and the
// smallest body caps.
const RATE_LIMIT = 5; // requests per IP per window
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_FULL_REPORT_LENGTH = 20000;
const MAX_STRUCTURED_DATA_JSON_LENGTH = 30000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.RESEND_API_KEY) {
    console.error("[api/intake] FATAL: RESEND_API_KEY is not set");
    res.status(500).json({ success: false, error: "Email configuration missing." });
    return;
  }

  const { structuredData, fullReport } = (req.body || {}) as {
    structuredData?: Record<string, unknown>;
    fullReport?: string;
  };

  if (!structuredData || !fullReport) {
    res.status(400).json({ success: false, error: "Missing required payload fields (structuredData, fullReport)." });
    return;
  }

  // Carbon Pass 1, finding #5: cap the client-fabricated payload so a
  // single call cannot smuggle an oversized report into an email.
  if (fullReport.length > MAX_FULL_REPORT_LENGTH) {
    res.status(400).json({ success: false, error: "Report payload exceeds the size limit." });
    return;
  }
  if (JSON.stringify(structuredData).length > MAX_STRUCTURED_DATA_JSON_LENGTH) {
    res.status(400).json({ success: false, error: "Structured data payload exceeds the size limit." });
    return;
  }

  if (!checkRateLimit(`intake:${getClientIp(req)}`, RATE_LIMIT, RATE_LIMIT_WINDOW_MS)) {
    res.status(429).json({ success: false, error: "Too many requests — please try again shortly." });
    return;
  }

  let recipient: string;
  let sender: string;
  try {
    recipient = getNotificationRecipient();
    sender = getSenderAddress();
  } catch (err) {
    console.error("[api/intake] FATAL: email configuration missing:", err instanceof Error ? err.message : String(err));
    res.status(500).json({ success: false, error: "Email configuration missing." });
    return;
  }

  const statusEmoji = String(structuredData.statusEmoji || "⚪");
  const statusLabel = String(structuredData.statusLabel || "Inquiry Incomplete");
  const applicantName = String(structuredData.fullName || "New Rental Inquiry");

  try {
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
      console.error("[api/intake] Resend error:", error);
      res.status(500).json({ success: false, error: "Failed to dispatch email." });
      return;
    }

    res.status(200).json({ success: true, message: "Inquiry submitted and emailed successfully." });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/intake] Internal error:", message);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
}
