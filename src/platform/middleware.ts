import type { AppDeps } from "../deps.js";
import type { RouteMiddleware } from "./route.js";

/** Pass through factories. Tasks 6 to 8 replace these with real auth, rate limiting and idempotency. */
export function productionMiddleware(_deps: AppDeps): RouteMiddleware {
  return {
    auth: () => (_req, _res, next) => next(),
    rateLimit: () => (_req, _res, next) => next(),
    idempotency: () => (_req, _res, next) => next(),
  };
}
