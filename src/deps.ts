import type { Pool } from "pg";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { MemoryRateLimiter, UpstashRateLimiter, type RateLimiter } from "./platform/ratelimit.js";
import { MemoryScheduler, type DeliveryScheduler } from "./platform/scheduler.js";
import { MemoryCache, UpstashCache, type Cache } from "./platform/cache.js";
import { createLogger, type Logger } from "./platform/logger.js";

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
  return {
    pool: createPool(config.DATABASE_URL),
    limiter,
    scheduler: new MemoryScheduler(),
    cache,
    logger,
    config,
  };
}
