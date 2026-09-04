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
