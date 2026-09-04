import { z } from "zod";
import { defineRoute } from "../platform/route.js";

const Check = z.object({ ok: z.boolean(), latency_ms: z.number() });
const Health = z.object({ status: z.enum(["ok", "degraded"]), version: z.string(), checks: z.object({ postgres: Check, redis: Check }) });

async function timed(fn: () => Promise<unknown>): Promise<{ ok: boolean; latency_ms: number }> {
  const started = Date.now();
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 500))]);
    return { ok: true, latency_ms: Date.now() - started };
  } catch {
    return { ok: false, latency_ms: Date.now() - started };
  }
}

export const healthRoutes = [
  defineRoute({
    method: "get", path: "/health", summary: "Dependency checks", tag: "Meta", auth: "none", limit: "none",
    response: Health,
    handler: async ({ deps, res }) => {
      const postgres = await timed(() => deps.pool.query("select 1"));
      const redis = await timed(() => deps.cache.get("health"));
      const status = postgres.ok && redis.ok ? "ok" : "degraded";
      res.status(status === "ok" ? 200 : 503);
      return { status, version: deps.config.PLUTUS_VERSION, checks: { postgres, redis } };
    },
  }),
];
