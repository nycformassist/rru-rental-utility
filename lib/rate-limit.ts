/**
 * lib/rate-limit.ts — in-memory per-IP rate limiting for the API routes.
 *
 * Carbon Pass 1, finding #5: the /api/* endpoints had no rate limiting,
 * so automated scripts could drain Gemini quota or abuse the email
 * endpoint as an open relay. Each handler calls checkRateLimit() with a
 * limit appropriate to the route's cost (AI calls are expensive; email
 * sends are the most abuse-prone).
 *
 * Carbon Pass 2, Finding 3: getClientIp used to trust the leftmost
 * X-Forwarded-For entry, which any client can forge — a random IP per
 * request got a fresh bucket every time. On Vercel, `x-real-ip` /
 * `x-vercel-forwarded-for` are overwritten at the edge and cannot be
 * spoofed by the client, so those are preferred; otherwise fall back to
 * the socket's remote address. The bucket map is now capped (MAX_BUCKETS)
 * with oldest-first eviction so a spoofed-IP flood cannot grow it
 * without bound.
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

// Hard cap on buckets so a flood of distinct keys cannot grow the map
// without bound (memory-exhaustion / O(N) iteration DoS).
const MAX_BUCKETS = 5000;

// Prune stale buckets opportunistically so the map cannot grow unbounded.
function prune(now: number): void {
  if (buckets.size < 1000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  // If the map is still at the cap after deleting expired buckets, evict
  // the oldest entries (Map preserves insertion order) so memory and
  // iteration time stay bounded.
  while (buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
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

/**
 * Best-effort client IP from a Vercel/Express request.
 *
 * Carbon Pass 2, Finding 3: NEVER trust the leftmost X-Forwarded-For
 * entry — any client can forge it. On Vercel, `x-real-ip` and
 * `x-vercel-forwarded-for` are set/overwritten at the edge, so those are
 * the only forwarded headers we trust. Otherwise use the socket's remote
 * address (the actual TCP peer).
 */
export function getClientIp(req: { headers?: Record<string, unknown>; socket?: { remoteAddress?: string } }): string {
  const vercelIp = req.headers?.["x-real-ip"] ?? req.headers?.["x-vercel-forwarded-for"];
  if (typeof vercelIp === "string" && vercelIp.trim().length > 0) {
    return vercelIp.split(",")[0].trim();
  }
  if (Array.isArray(vercelIp) && vercelIp.length > 0) {
    return String(vercelIp[0]).split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}
