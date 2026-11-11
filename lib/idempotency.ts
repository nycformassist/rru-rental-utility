/**
 * lib/idempotency.ts — in-memory idempotency for POST /api/submit-inquiry.
 *
 * DeepSeek correction: a network retry or double-click re-POSTing the
 * same {answers, language} would otherwise generate a second report and
 * send a duplicate email. The payload is hashed (SHA-256 over a
 * key-sorted JSON encoding) and the successful response is cached for
 * 10 minutes; a repeat within the window returns the original result
 * instead of re-running generation + email.
 *
 * Same pattern as lib/rate-limit.ts (bounded in-memory Map, prune +
 * oldest-first eviction) and the same limitation: on Vercel serverless
 * it is enforced per function instance, not globally. It stops the
 * common duplicate-submit cases (retry, double-click on one warm
 * instance); it is not a substitute for a shared store if abuse becomes
 * a real problem.
 */

import { createHash } from "node:crypto";

interface SubmissionEntry {
  body: Record<string, unknown>;
  storedAt: number;
}

const submissions = new Map<string, SubmissionEntry>();

const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ENTRIES = 5000;

// Key-sorted JSON encoding so the same payload hashes identically
// regardless of object key order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

/** Deterministic SHA-256 hex digest for a submission payload. */
export function submissionHash(answers: Record<string, unknown>, language: string): string {
  return createHash("sha256").update(stableStringify({ answers, language })).digest("hex");
}

// Prune stale entries opportunistically so the map cannot grow unbounded.
function prune(now: number): void {
  if (submissions.size < 1000) return;
  for (const [key, entry] of submissions) {
    if (entry.storedAt + IDEMPOTENCY_WINDOW_MS <= now) submissions.delete(key);
  }
  // If the map is still at the cap after deleting expired entries, evict
  // the oldest entries (Map preserves insertion order) so memory and
  // iteration time stay bounded.
  while (submissions.size >= MAX_ENTRIES) {
    const oldest = submissions.keys().next().value;
    if (oldest === undefined) break;
    submissions.delete(oldest);
  }
}

/**
 * Returns the cached successful response body for this submission hash,
 * or null if there is none (or it expired). Callers return the cached
 * body instead of re-running generation + email.
 */
export function getCachedSubmission(hash: string): Record<string, unknown> | null {
  const now = Date.now();
  const entry = submissions.get(hash);
  if (!entry) return null;
  if (entry.storedAt + IDEMPOTENCY_WINDOW_MS <= now) {
    submissions.delete(hash);
    return null;
  }
  return entry.body;
}

/** Caches a successful submission response. Call only after the email was sent. */
export function cacheSubmission(hash: string, body: Record<string, unknown>): void {
  prune(Date.now());
  submissions.set(hash, { body, storedAt: Date.now() });
}
