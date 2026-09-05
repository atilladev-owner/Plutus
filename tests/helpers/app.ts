import type { Express } from "express";
import { createApp } from "../../src/create-app.js";
import type { AppDeps } from "../../src/deps.js";
import { loadConfig } from "../../src/config.js";
import { testPool } from "./db.js";
import { MemoryRateLimiter } from "../../src/platform/ratelimit.js";
import { MemoryScheduler } from "../../src/platform/scheduler.js";
import { MemoryCache } from "../../src/platform/cache.js";
import { createLogger } from "../../src/platform/logger.js";
import { allRoutes } from "../../src/routes/index.js";
import { productionMiddleware } from "../../src/platform/middleware.js";
import type { RouteDef } from "../../src/platform/route.js";

export async function makeTestApp(overrides: Partial<AppDeps> = {}, routes: RouteDef[] = allRoutes): Promise<{ app: Express; deps: AppDeps; scheduler: MemoryScheduler; limiter: MemoryRateLimiter }> {
  const scheduler = new MemoryScheduler();
  const limiter = new MemoryRateLimiter();
  const deps: AppDeps = {
    pool: testPool(),
    limiter,
    scheduler,
    cache: new MemoryCache(),
    logger: createLogger("silent"),
    config: loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test", CRON_SECRET: "test-cron-secret-0123456789", PUBLIC_BASE_URL: "http://localhost:3000" }),
    ...overrides,
  };
  const app = createApp(deps, routes, productionMiddleware(deps));
  return { app, deps, scheduler, limiter };
}
