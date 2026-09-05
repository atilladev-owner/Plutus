import type { Request, Response, NextFunction } from "express";
import type { AppDeps } from "../deps.js";
import type { RouteMiddleware } from "./route.js";
import { bearerAuth } from "./auth.js";
import { rateLimitMiddleware } from "./ratelimit.js";

const passThrough = (_req: Request, _res: Response, next: NextFunction) => next();

/** Idempotency stays pass through until task 8 replaces it. */
export function productionMiddleware(deps: AppDeps): RouteMiddleware {
  return {
    auth: bearerAuth(deps),
    rateLimit: rateLimitMiddleware(deps),
    idempotency: () => passThrough,
  };
}
