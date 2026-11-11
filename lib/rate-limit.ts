/**
 * lib/rate-limit.ts — in-memory per-IP rate limiting for the API routes.
 *
 * Carbon Pass 1, finding #5: the /api/* endpoints had no rate limiting,
 * so automated scripts could drain Gemini quota or abuse /api/intake as
 * an open email relay. Each handler calls checkRateLimit() with a limit
 * appropriate to the route's cost (AI calls are expensive; email sends
 * are the most abuse-prone).
 *
 * LIMITATION: this is in-memory, so on Vercel serverless it is enforced
 * per function instance, not globally across all instances. It is a
 * meaningful mitigation (stops a single client hammering one warm
 * instance) but not a substitute for edge-level protection (Vercel
 * Firewall / Turnstile) if abuse becomes a real problem.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Prune stale buckets opportunistically so the map cannot grow unbounded.
function prune(now: number): void {
  if (buckets.size < 1000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Returns true if the request is within the limit, false if it should be
 * rejected with HTTP 429. `key` should identify the caller (e.g.
 * `evaluate:<client-ip>`); `limit` is max requests per `windowMs`.
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  prune(now);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/** Best-effort client IP from a Vercel/Express request. */
export function getClientIp(req: { headers?: Record<string, unknown>; socket?: { remoteAddress?: string } }): string {
  const forwarded = req.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0]).split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}
