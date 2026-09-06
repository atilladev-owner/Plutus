import type { Pool } from "pg";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { MemoryRateLimiter, UpstashRateLimiter, type RateLimiter } from "./platform/ratelimit.js";
import { MemoryScheduler, QStashScheduler, type DeliveryScheduler } from "./platform/scheduler.js";
import { MemoryCache, UpstashCache, type Cache } from "./platform/cache.js";
import { createLogger, type Logger } from "./platform/logger.js";
import { deliverOnce } from "./platform/deliver.js";

export interface AppDeps {
  pool: Pool;
  limiter: RateLimiter;
  scheduler: DeliveryScheduler;
  cache: Cache;
  logger: Logger;
  config: Config;
}

/** Production wiring. Task 11 replaces the remaining memory double with Upstash when the variables are present. */
export function buildProductionDeps(env: NodeJS.ProcessEnv = process.env): AppDeps {
  const config = loadConfig(env);
  const logger = createLogger(config.NODE_ENV === "test" ? "silent" : "info");
  const hasUpstash = Boolean(config.UPSTASH_REDIS_REST_URL && config.UPSTASH_REDIS_REST_TOKEN);
  const limiter: RateLimiter = hasUpstash
    ? new UpstashRateLimiter(config.UPSTASH_REDIS_REST_URL!, config.UPSTASH_REDIS_REST_TOKEN!)
    : new MemoryRateLimiter();
  logger.info({ limiter: hasUpstash ? "upstash" : "memory" }, "rate limiter selected");
  const cache: Cache = hasUpstash
    ? new UpstashCache(config.UPSTASH_REDIS_REST_URL!, config.UPSTASH_REDIS_REST_TOKEN!)
    : new MemoryCache();
  logger.info({ cache: hasUpstash ? "upstash" : "memory" }, "cache selected");
  // deliverOnce takes deps by reference, and the memory scheduler's fallback closes over
  // deliverOnce(deps, id). deps cannot appear in its own initializer, so it is built first
  // with a placeholder scheduler and the real one is assigned right after: the memory
  // scheduler's closure only reads deps.pool etc. once schedule() actually runs, which is
  // always after this function has returned. deliver.ts only imports AppDeps as a type,
  // which TypeScript erases from the compiled output, so there is no runtime import cycle
  // between deps.ts and platform/deliver.ts despite the logical dependency each way.
  const deps: AppDeps = {
    pool: createPool(config.DATABASE_URL, (err) => logger.warn({ err }, "idle database client dropped")),
    limiter,
    scheduler: new MemoryScheduler(),
    cache,
    logger,
    config,
  };
  const hasQStash = Boolean(config.QSTASH_TOKEN);
  deps.scheduler = hasQStash
    ? new QStashScheduler(config.QSTASH_TOKEN!, `${config.PUBLIC_BASE_URL}/internal/webhooks/deliver`)
    : new MemoryScheduler((id) => deliverOnce(deps, id));
  logger.info({ scheduler: hasQStash ? "qstash" : "memory" }, "scheduler selected");
  return deps;
}
