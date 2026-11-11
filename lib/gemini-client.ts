/**
 * lib/gemini-client.ts
 *
 * Single place that actually talks to Gemini. Both api/evaluate.ts and
 * lib/report.ts (used by api/generate-report.ts and api/submit-inquiry.ts)
 * call generateJSON() instead of touching the provider directly, so
 * retry/backoff/fallback behavior only needs to exist — and be fixed —
 * in one place.
 *
 * PROVIDER: Vertex AI (Google Cloud), NOT the Gemini Developer API /
 * AI Studio. Switched 2026-11-11 (owner direction: everything goes
 * through Cloud going forward) because the AI Studio billing account
 * has an outstanding balance and Gemini refused every /api/evaluate
 * call with 403 PERMISSION_DENIED. Same service-account pattern as
 * Inner Temple Live Ask (api/_gemini.ts in the inner-temple repo),
 * which is the proven reference for this file.
 *
 * AUTH: a Google Cloud service account, via OAuth 2.0. The service
 * account JSON lives ONLY in the server environment variable
 * VERTEX_SERVICE_ACCOUNT_JSON (set in the Vercel dashboard by the
 * owner — same value as Inner Temple's). It is read here, on the
 * server, and nowhere else. The access token is obtained by signing a
 * JWT with the service account's private key (node:crypto, no extra
 * dependency) and exchanging it at oauth2.googleapis.com/token. The
 * token is cached in module memory until near expiry. NOTHING in this
 * file ever logs, returns, or embeds the credential value. There is
 * no API-key fallback: if the service account is missing, the module
 * fails closed with a clear "not configured" error.
 *
 * The service account needs the Vertex AI User role
 * (roles/aiplatform.user) on the project (default inner-temple-514402).
 *
 * Handles the "This model is currently experiencing high demand" (503)
 * and rate-limit (429) responses Gemini returns during capacity spikes:
 *   1. Retry the primary model a few times with exponential backoff + jitter.
 *   2. If the primary is still unavailable, fail over once to a secondary
 *      model from a different generation.
 *   3. If both are exhausted, throw UpstreamUnavailableError so the
 *      handler can return HTTP 503 (retry-worthy) instead of a generic 500.
 *
 * A 404 (NOT_FOUND — e.g. a model ID that does not exist on Vertex AI)
 * is NOT retried, but it DOES trigger the one-time fallback: a bad
 * primary model ID must not take the whole endpoint down (Carbon Pass 1,
 * finding #1). If the fallback also 404s, that is a configuration error
 * and is thrown as-is (HTTP 500), not masked as a capacity problem.
 *
 * A 403 (PERMISSION_DENIED — billing or the service account lacking the
 * Vertex AI User role) is NEVER retried and never fails over: retrying
 * a permission error cannot succeed, and failing over would only burn
 * a second call on the same blocked account. It is surfaced as-is so
 * the server log shows the exact upstream reason.
 */

import { sign as cryptoSign } from "node:crypto";
import { getModelNames } from "./constants.js";

// Project / location are read LAZILY at request time (not module-level
// constants): in Node ESM, static imports evaluate before dotenv runs
// in local dev, so module-level env reads silently ignored .env values
// (Carbon Pass 2, Fix 1 — the same reason model names are read lazily
// via getModelNames()).
function getVertexConfig(): { projectId: string; location: string; base: string } {
  const projectId = process.env.VERTEX_PROJECT_ID?.trim() || "inner-temple-514402";
  const location = process.env.VERTEX_LOCATION?.trim() || "global";
  const base =
    location === "global"
      ? "https://aiplatform.googleapis.com/v1"
      : `https://${location}-aiplatform.googleapis.com/v1`;
  return { projectId, location, base };
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
// Vercel functions run with maxDuration 30s: 25s per attempt leaves the
// handler room to return a clean error instead of being killed mid-flight.
const VERTEX_TIMEOUT_MS = 25_000;

/** Thrown when both the primary and fallback models are unavailable after retries. */
export class UpstreamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamUnavailableError";
  }
}

/** A Vertex AI HTTP error, carrying the upstream status code so the
 *  retry/failover logic can tell "busy, worth retrying" apart from
 *  "bad request" or "permission denied" without parsing messages. */
export class VertexError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "VertexError";
    this.status = status;
  }
}

const RETRYABLE_STATUS_CODES = [429, 503];
// Statuses that trigger the one-time fallback to the secondary model.
// 404 is included: a model ID that does not exist on the API must fall
// back instead of failing the request outright. 404 is deliberately NOT
// in RETRYABLE_STATUS_CODES — retrying a bad model ID can never succeed.
// 403 is in NEITHER list: a billing/permission failure must surface
// immediately, never retry and never fail over.
const FAILOVER_STATUS_CODES = [404, 429, 503];
// Carbon Pass 2, Finding 10: worst-case retry latency exceeded the
// Vercel Hobby function timeout (3 attempts x primary + 3 x fallback =
// 6 Gemini calls per invocation, and the client retried 503s on top of
// that). 2 attempts per model = 4 fast attempts max.
const MAX_ATTEMPTS_PER_MODEL = 2;
const BASE_DELAY_MS = 800;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Vertex AI auth (service account, OAuth 2.0) ---------------------------
// Ported from Inner Temple's api/_gemini.ts (proven live 2026-11-11).
// No google-auth-library dependency: the JWT -> access-token exchange is
// a short, standard flow implemented here with node:crypto (RS256).

export interface ServiceAccountJson {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

/** Parse the service account JSON from the environment. Returns null
 *  when the env var is absent, malformed, or missing the fields the
 *  JWT exchange needs. Never logs the credential. */
export function getVertexServiceAccount(): ServiceAccountJson | null {
  const raw = process.env.VERTEX_SERVICE_ACCOUNT_JSON || "";
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ServiceAccountJson;
    if (typeof parsed.client_email !== "string" || !parsed.client_email) return null;
    if (typeof parsed.private_key !== "string" || !parsed.private_key) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** True when a usable service account is configured. This is NOT proof
 *  of authorization — only a live request proves that (401/403 = the
 *  service account lacks the Vertex AI User role, or the key is bad).
 *  Handlers and server.ts fail closed on this check. */
export function isVertexConfigured(): boolean {
  return getVertexServiceAccount() !== null;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

interface TokenCache {
  token: string;
  expiresAt: number;
  email: string;
}
let tokenCache: TokenCache | null = null;

/** Test-only reset for the module-level token cache. */
export function _resetVertexTokenCache(): void {
  tokenCache = null;
}

/** Obtain an OAuth 2.0 access token for the Vertex AI API by signing a
 *  JWT with the service account's private key and exchanging it at
 *  oauth2.googleapis.com/token. Returns null when no service account
 *  is configured or the exchange fails. The token is cached in module
 *  memory until shortly before expiry. */
export async function getVertexAccessToken(
  account?: ServiceAccountJson | null
): Promise<string | null> {
  const sa = account ?? getVertexServiceAccount();
  if (!sa) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.email === sa.client_email && tokenCache.expiresAt > nowSec + 60) {
    return tokenCache.token;
  }
  const header = { alg: "RS256", typ: "JWT", ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: TOKEN_URL,
    scope: TOKEN_SCOPE,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const unsigned = `${base64urlEncode(new TextEncoder().encode(JSON.stringify(header)))}.${base64urlEncode(
    new TextEncoder().encode(JSON.stringify(payload))
  )}`;
  let signature: Uint8Array;
  try {
    signature = cryptoSign("sha256", new TextEncoder().encode(unsigned), sa.private_key);
  } catch {
    return null;
  }
  const jwt = `${unsigned}.${base64urlEncode(signature)}`;
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(jwt)}`,
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    tokenCache = null;
    return null;
  }
  const data = (await res.json().catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;
  if (typeof data.access_token !== "string" || !data.access_token) return null;
  const expiresIn = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
  tokenCache = { token: data.access_token, expiresAt: nowSec + expiresIn, email: sa.client_email };
  return data.access_token;
}

// --- Vertex AI generateContent (Bearer token, never an API key) ------------

/**
 * One generateContent call against Vertex AI. Returns the concatenated
 * response text (expected to be JSON — the caller parses it). Throws
 * VertexError carrying the upstream HTTP status on any non-200.
 */
async function callVertexOnce(
  model: string,
  systemInstruction: string,
  prompt: string,
  responseSchema: object | undefined,
  accessToken: string
): Promise<string> {
  const { projectId, location, base } = getVertexConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERTEX_TIMEOUT_MS);
  try {
    const url = `${base}/projects/${projectId}/locations/${location}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
      body: JSON.stringify({
        // Vertex AI's REST schema names this field systemInstruction
        // (camelCase). The AI Studio path sent system_instruction
        // (snake_case) and the Developer API accepted it, but Vertex
        // AI's REST frontend rejects the snake_case name with a 400
        // ("Invalid JSON payload received. Unknown name"), so the
        // documented camelCase name is required here.
        systemInstruction: { parts: [{ text: systemInstruction }] },
        // Vertex AI requires every Content in `contents` to carry an
        // explicit role of "user" or "model". The Gemini Developer API
        // defaults a missing role to "user", but Vertex AI rejects a
        // role-less content with 400 INVALID_ARGUMENT ("Please use a
        // valid role: user, model."), so the role is set explicitly
        // here. The system prompt lives ONLY in systemInstruction
        // above — it is never a content entry, so there is no "system"
        // role in contents (Vertex AI has no such role).
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          ...(responseSchema ? { responseSchema } : {}),
        },
      }),
    });
    // Read the raw text first so a non-200 upstream error body is
    // captured verbatim for the server log — the exact message is what
    // diagnoses a 400/403, and parsing alone would hide it when the
    // body is not JSON. Server-side log only: never returned to the
    // client, and it never contains the credential or access token.
    const raw = await res.text().catch(() => "");
    let data: Record<string, unknown> = {};
    try {
      data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      data = {};
    }
    if (!res.ok) {
      const upstreamMessage =
        (data.error as Record<string, unknown> | undefined)?.message ??
        (typeof data.message === "string" ? data.message : "");
      const message =
        typeof upstreamMessage === "string" && upstreamMessage.length > 0
          ? String(upstreamMessage)
          : `Vertex AI returned HTTP ${res.status}`;
      console.error("[vertex] generateContent failed", { model, status: res.status, body: raw.slice(0, 4000) });
      // A 401 here means the cached token was rejected; drop it so the
      // next request re-authenticates instead of reusing a bad token.
      if (res.status === 401) _resetVertexTokenCache();
      throw new VertexError(res.status, message);
    }
    const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
    const parts = (candidates?.[0]?.content as Record<string, unknown> | undefined)?.parts as
      | Array<Record<string, unknown>>
      | undefined;
    const text = (parts ?? []).map((p) => (typeof p.text === "string" ? p.text : "")).join("");
    if (!text) {
      console.warn("[vertex] generateContent returned 200 with no text content", { model });
    }
    return text;
  } catch (err) {
    // The AbortController fires on timeout: surface it as a 503-style
    // upstream failure so the retry logic can treat it as transient.
    if (err instanceof Error && err.name === "AbortError") {
      throw new VertexError(503, `Vertex AI request timed out after ${VERTEX_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The upstream status code for an error, so the retry/failover logic
 * can tell "busy, worth retrying" apart from "bad request" or
 * "permission denied." VertexError carries it directly; anything else
 * (e.g. a network failure) has no status and is treated as a
 * non-retryable, non-failover error by the caller.
 */
function extractStatusCode(err: unknown): number | null {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) return status;
  }
  return null;
}

async function callModelWithRetry(
  modelName: string,
  systemInstruction: string,
  prompt: string,
  responseSchema?: object
): Promise<string> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
    try {
      const accessToken = await getVertexAccessToken();
      if (!accessToken) {
        // Fail closed: no usable service account (missing env var,
        // malformed JSON, or a failed token exchange). Never fall back
        // to an API key — there is no API-key path anymore.
        throw new Error(
          "VERTEX_SERVICE_ACCOUNT_JSON is not configured or the service account could not be authenticated"
        );
      }
      return await callVertexOnce(modelName, systemInstruction, prompt, responseSchema, accessToken);
    } catch (err) {
      lastErr = err;
      const status = extractStatusCode(err);
      const retryable = status !== null && RETRYABLE_STATUS_CODES.includes(status);
      if (!retryable || attempt === MAX_ATTEMPTS_PER_MODEL) throw err;

      const delay = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      console.warn(
        `[gemini-client] ${modelName} busy (status ${status}). Retrying in ${delay}ms... (attempt ${attempt}/${MAX_ATTEMPTS_PER_MODEL})`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Generates a JSON response, with retry-with-backoff on the primary model
 * and a one-time fallback to a different model generation if the primary
 * is still unavailable after retries.
 *
 * `responseSchema`, if provided, is passed to Vertex AI's structured-output
 * mode (see lib/constants.ts EVALUATE_RESPONSE_SCHEMA /
 * REPORT_RESPONSE_SCHEMA — including the structured
 * paymentDocumentationContext field) so the model is constrained to
 * return the exact field types requested — no strings where booleans
 * are expected, no missing required fields.
 */
export async function generateJSON(
  systemInstruction: string,
  prompt: string,
  responseSchema?: object
): Promise<string> {
  // Model IDs are read lazily at request time (Carbon Pass 2, Fix 1):
  // module-level reads evaluated before dotenv.config() ran in local dev.
  const { primary: primaryModel, fallback: fallbackModel } = getModelNames();

  try {
    const responseText = await callModelWithRetry(primaryModel, systemInstruction, prompt, responseSchema);
    return (responseText || "{}").trim();
  } catch (primaryErr) {
    const status = extractStatusCode(primaryErr);
    if (status === null || !FAILOVER_STATUS_CODES.includes(status)) {
      // Not a capacity issue and not a missing model (bad request, auth
      // failure, permission/billing failure, missing service account,
      // etc.) — don't mask it by trying a second model, just surface it.
      throw primaryErr;
    }

    console.warn(`[gemini-client] ${primaryModel} failed (status ${status}) — falling back to ${fallbackModel}.`);
    try {
      const responseText = await callModelWithRetry(fallbackModel, systemInstruction, prompt, responseSchema);
      return (responseText || "{}").trim();
    } catch (fallbackErr) {
      const fbStatus = extractStatusCode(fallbackErr);
      if (fbStatus !== null && RETRYABLE_STATUS_CODES.includes(fbStatus)) {
        throw new UpstreamUnavailableError(
          `Both ${primaryModel} and ${fallbackModel} are currently unavailable (Google capacity issue). Please try again shortly.`
        );
      }
      // Fallback 404 (or any other non-capacity error): a configuration
      // problem, not a capacity problem — surface it, don't mask as 503.
      throw fallbackErr;
    }
  }
}
