import { z } from "zod";
import { defineRoute } from "../platform/route.js";

const Check = z.object({ ok: z.boolean(), latency_ms: z.number() });
const Health = z.object({ status: z.enum(["ok", "degraded"]), version: z.string(), checks: z.object({ postgres: Check, redis: Check }) });

async function timed(fn: () => Promise<unknown>): Promise<{ ok: boolean; latency_ms: number }> {
  const started = Date.now();
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2500))]);
    return { ok: true, latency_ms: Date.now() - started };
  } catch {
    return { ok: false, latency_ms: Date.now() - started };
  }
}

export const healthRoutes = [
  defineRoute({
    method: "get", path: "/health", summary: "Dependency checks", tag: "Meta", auth: "none", limit: "public_meta",
    response: Health,
    handler: async ({ deps, res }) => {
      // Both checks at once, not one after the other: they share nothing, and running them
      // in sequence made the worst case the sum of the two 2.5 second budgets rather than
      // the larger of them. timed never rejects, it turns a failure into { ok: false }, so
      // Promise.all here can never short circuit on the first dependency that is down.
      const [postgres, redis] = await Promise.all([
        timed(() => deps.pool.query("select 1")),
        timed(() => deps.cache.get("health")),
      ]);
      const status = postgres.ok && redis.ok ? "ok" : "degraded";
      res.status(status === "ok" ? 200 : 503);
      return { status, version: deps.config.PLUTUS_VERSION, checks: { postgres, redis } };
    },
  }),
];
