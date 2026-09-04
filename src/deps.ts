import type { Pool } from "pg";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { MemoryRateLimiter, type RateLimiter } from "./platform/ratelimit.js";
import { MemoryScheduler, type DeliveryScheduler } from "./platform/scheduler.js";
import { MemoryCache, type Cache } from "./platform/cache.js";
import { createLogger, type Logger } from "./platform/logger.js";

export interface AppDeps {
  pool: Pool;
  limiter: RateLimiter;
  scheduler: DeliveryScheduler;
  cache: Cache;
  logger: Logger;
  config: Config;
}

/** Production wiring. Tasks 7, 10 and 11 replace the memory doubles with Upstash when the variables are present. */
export function buildProductionDeps(env: NodeJS.ProcessEnv = process.env): AppDeps {
  const config = loadConfig(env);
  const logger = createLogger(config.NODE_ENV === "test" ? "silent" : "info");
  return {
    pool: createPool(config.DATABASE_URL),
    limiter: new MemoryRateLimiter(),
    scheduler: new MemoryScheduler(),
    cache: new MemoryCache(),
    logger,
    config,
  };
}
