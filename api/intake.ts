/**
 * api/intake.ts — POST /api/intake
 *
 * Emails the finished Rental Inquiry Brief to the agency. Same Vercel
 * Node handler convention as api/evaluate.ts and api/generate-report.ts.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
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

// Set this to your actual agency inbox before going live.
const NOTIFICATION_RECIPIENT = "healthcarebyvalentine@gmail.com";

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

  const statusEmoji = String(structuredData.statusEmoji || "⚪");
  const statusLabel = String(structuredData.statusLabel || "Inquiry Incomplete");
  const applicantName = String(structuredData.fullName || "New Rental Inquiry");

  try {
    const client = getResendClient();
    const { error } = await client.emails.send({
      from: "RRU Rental Inquiry <onboarding@resend.dev>",
      to: [NOTIFICATION_RECIPIENT],
      subject: `[RRU™ Rental] ${statusEmoji} ${statusLabel}: ${applicantName}`,
      text: fullReport,
      html: `
        <div style="font-family: monospace; white-space: pre-wrap; font-size: 14px; color: #333; background-color: #f8fafc; padding: 20px; border-radius: 8px;">
          <p><strong>Status:</strong> ${statusEmoji} ${statusLabel}</p>
          <p><strong>Recommended Next Step:</strong> ${String(structuredData.recommendedNextStep || "Review manually")}</p>
          <hr style="border-color:#e2e8f0; margin: 12px 0;" />
          ${fullReport}
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
