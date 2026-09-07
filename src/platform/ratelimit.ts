import type { RequestHandler, Response } from "express";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { ApiError } from "../domain/errors.js";
import type { AppDeps } from "../deps.js";
import type { RouteDef, AuthedKey } from "./route.js";

export type RateBucket = "mint" | "sandbox" | "live" | "verify" | "verify_public" | "weight" | "place" | "stream";
export interface RateResult { ok: boolean; limit: number; remaining: number; resetAt: number }
export interface RateLimiter { limit(bucket: RateBucket, id: string, points?: number): Promise<RateResult> }

export const RATE_RULES: Record<RateBucket, { points: number; windowSeconds: number }> = {
  mint: { points: 5, windowSeconds: 3600 },
  sandbox: { points: 60, windowSeconds: 60 },
  live: { points: 600, windowSeconds: 60 },
  verify: { points: 10, windowSeconds: 60 },
  // The public exchange proof, spec 10.6: no key, two calls a minute per IP.
  verify_public: { points: 2, windowSeconds: 60 },
  // Endpoint weights, spec 10.9: 1,200 weight per minute per key, plus a ten per second
  // cap on order placement that weightLimit (weights.ts) charges on top of the weight.
  // The public market data reads (spec 10.6, src/routes/exchange-market-data.ts) spend out
  // of this same bucket and budget, keyed by IP instead of by key (rateLimitMiddleware below
  // falls back to req.ip whenever a route has no signed caller), since nothing in spec 10.9
  // gives the public reads a budget of their own and the id namespaces never collide: a key
  // id always looks like "key_...", never a dotted IP address or "::1".
  weight: { points: 1200, windowSeconds: 60 },
  place: { points: 10, windowSeconds: 1 },
  // The stream, spec 10.7: 12 opens a minute per address, charged at open time through
  // this same shared limiter, ahead of the local, per process concurrency cap
  // (src/routes/exchange-stream.ts's own activeStreams count) rather than instead of it.
  stream: { points: 12, windowSeconds: 60 },
};

/** Sliding window in process. Correct for one instance, which is exactly what tests and local dev are.
 * Each hit remembers its own point cost so a variable weight (not just one point per call)
 * can share the same window and remaining-budget accounting. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, Array<{ at: number; points: number }>>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  async limit(bucket: RateBucket, id: string, points = 1): Promise<RateResult> {
    const rule = RATE_RULES[bucket];
    const key = `${bucket}:${id}`;
    const t = this.now();
    const windowStart = t - rule.windowSeconds * 1000;
    const kept = (this.hits.get(key) ?? []).filter((h) => h.at > windowStart);
    const used = kept.reduce((sum, h) => sum + h.points, 0);
    const ok = used + points <= rule.points;
    if (ok) kept.push({ at: t, points });
    this.hits.set(key, kept);
    const usedNow = kept.reduce((sum, h) => sum + h.points, 0);
    const oldest = kept[0]?.at ?? t;
    return { ok, limit: rule.points, remaining: Math.max(0, rule.points - usedNow), resetAt: oldest + rule.windowSeconds * 1000 };
  }
}

export class UpstashRateLimiter implements RateLimiter {
  private readonly limiters: Record<RateBucket, Ratelimit>;
  constructor(url: string, token: string) {
    const redis = new Redis({ url, token });
    const make = (b: RateBucket) => new Ratelimit({
      redis, prefix: `plutus:rl:${b}`,
      limiter: Ratelimit.slidingWindow(RATE_RULES[b].points, `${RATE_RULES[b].windowSeconds} s`),
    });
    this.limiters = {
      mint: make("mint"), sandbox: make("sandbox"), live: make("live"), verify: make("verify"),
      verify_public: make("verify_public"), weight: make("weight"), place: make("place"), stream: make("stream"),
    };
  }
  async limit(bucket: RateBucket, id: string, points = 1): Promise<RateResult> {
    const r = await this.limiters[bucket].limit(id, { rate: points });
    return { ok: r.success, limit: r.limit, remaining: r.remaining, resetAt: r.reset };
  }
}

/** Sets the RateLimit-* headers a result implies and returns the Retry-After value in
 * seconds. Shared by rateLimitMiddleware below and by weightLimit (weights.ts), so the
 * two never drift into emitting slightly different headers for the same kind of result. */
export function applyRateLimitHeaders(res: Response, result: RateResult): number {
  const msLeft = result.resetAt - Date.now();
  const resetSeconds = msLeft <= 0 ? 1 : Math.trunc((msLeft + 999) / 1000);
  res.setHeader("RateLimit-Limit", String(result.limit));
  res.setHeader("RateLimit-Remaining", String(result.remaining));
  res.setHeader("RateLimit-Reset", String(resetSeconds));
  return resetSeconds;
}

/** Calls the configured limiter with the same half second budget rateLimitMiddleware always
 * enforced, failing closed with 503 rather than letting a wedged limiter hang the request.
 * Shared with weightLimit (weights.ts) for the same reason applyRateLimitHeaders is. */
export async function limitWithTimeout(deps: AppDeps, bucket: RateBucket, id: string, points = 1): Promise<RateResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      deps.limiter.limit(bucket, id, points),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("limiter timeout")), 500); }),
    ]);
  } catch (err) {
    deps.logger.error({ err: (err as Error).message }, "rate limiter unavailable");
    throw new ApiError(503, "rate_limiter_unavailable", "the rate limiter is unreachable; try again shortly");
  } finally {
    clearTimeout(timer);
  }
}

export function rateLimitMiddleware(deps: AppDeps) {
  return (def: RouteDef): RequestHandler => async (req, res, next) => {
    try {
      const mode = def.limit ?? (def.auth === "bearer" ? "standard" : "none");
      if (mode === "none") return next();
      const key = res.locals.key as AuthedKey | undefined;
      const bucket: RateBucket = mode === "standard" ? (key?.mode === "live" ? "live" : "sandbox") : mode;
      const id = key?.id ?? req.ip ?? "unknown";
      // def.weight (spec 10.9) is never set on a plain bearer or key mint route, so this
      // stays a plain one point charge for every route that already relied on that; the
      // public market data reads (src/routes/exchange-market-data.ts) are the one caller
      // that sets it here, spending 5 or 10 points against the IP-keyed "weight" bucket
      // instead of the flat one point every other rate limited public route spends.
      const points = typeof def.weight === "function" ? def.weight(req) : (def.weight ?? 1);
      const result = await limitWithTimeout(deps, bucket, id, points);
      const resetSeconds = applyRateLimitHeaders(res, result);
      if (!result.ok) throw new ApiError(429, "rate_limited", `limit of ${result.limit} per window reached`, undefined, { "Retry-After": String(resetSeconds) });
      next();
    } catch (err) {
      next(err);
    }
  };
}
