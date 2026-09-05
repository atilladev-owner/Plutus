import type { RequestHandler } from "express";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { ApiError } from "../domain/errors.js";
import type { AppDeps } from "../deps.js";
import type { RouteDef, AuthedKey } from "./route.js";

export type RateBucket = "mint" | "sandbox" | "live" | "verify";
export interface RateResult { ok: boolean; limit: number; remaining: number; resetAt: number }
export interface RateLimiter { limit(bucket: RateBucket, id: string): Promise<RateResult> }

export const RATE_RULES: Record<RateBucket, { points: number; windowSeconds: number }> = {
  mint: { points: 5, windowSeconds: 3600 },
  sandbox: { points: 60, windowSeconds: 60 },
  live: { points: 600, windowSeconds: 60 },
  verify: { points: 10, windowSeconds: 60 },
};

/** Sliding window in process. Correct for one instance, which is exactly what tests and local dev are. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  async limit(bucket: RateBucket, id: string): Promise<RateResult> {
    const rule = RATE_RULES[bucket];
    const key = `${bucket}:${id}`;
    const t = this.now();
    const windowStart = t - rule.windowSeconds * 1000;
    const kept = (this.hits.get(key) ?? []).filter((h) => h > windowStart);
    const ok = kept.length < rule.points;
    if (ok) kept.push(t);
    this.hits.set(key, kept);
    const oldest = kept[0] ?? t;
    return { ok, limit: rule.points, remaining: Math.max(0, rule.points - kept.length), resetAt: oldest + rule.windowSeconds * 1000 };
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
    this.limiters = { mint: make("mint"), sandbox: make("sandbox"), live: make("live"), verify: make("verify") };
  }
  async limit(bucket: RateBucket, id: string): Promise<RateResult> {
    const r = await this.limiters[bucket].limit(id);
    return { ok: r.success, limit: r.limit, remaining: r.remaining, resetAt: r.reset };
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
      let result: RateResult;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([
          deps.limiter.limit(bucket, id),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("limiter timeout")), 500); }),
        ]);
      } catch (err) {
        deps.logger.error({ err: (err as Error).message }, "rate limiter unavailable");
        throw new ApiError(503, "rate_limiter_unavailable", "the rate limiter is unreachable; try again shortly");
      } finally {
        clearTimeout(timer);
      }
      const msLeft = result.resetAt - Date.now();
      const resetSeconds = msLeft <= 0 ? 1 : Math.trunc((msLeft + 999) / 1000);
      res.setHeader("RateLimit-Limit", String(result.limit));
      res.setHeader("RateLimit-Remaining", String(result.remaining));
      res.setHeader("RateLimit-Reset", String(resetSeconds));
      if (!result.ok) throw new ApiError(429, "rate_limited", `limit of ${result.limit} per window reached`, undefined, { "Retry-After": String(resetSeconds) });
      next();
    } catch (err) {
      next(err);
    }
  };
}
