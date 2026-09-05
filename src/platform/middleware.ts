import type { Request, Response, NextFunction } from "express";
import type { AppDeps } from "../deps.js";
import type { RouteMiddleware } from "./route.js";
import { bearerAuth } from "./auth.js";

const passThrough = (_req: Request, _res: Response, next: NextFunction) => next();

/** Rate limiting and idempotency stay pass through until tasks 7 and 8 replace them. */
export function productionMiddleware(deps: AppDeps): RouteMiddleware {
  return {
    auth: bearerAuth(deps),
    rateLimit: () => passThrough,
    idempotency: () => passThrough,
  };
}
