import type { AppDeps } from "../deps.js";
import type { RouteMiddleware } from "./route.js";
import { bearerAuth } from "./auth.js";
import { rateLimitMiddleware } from "./ratelimit.js";
import { idempotencyMiddleware } from "./idempotency.js";

export function productionMiddleware(deps: AppDeps): RouteMiddleware {
  return {
    auth: bearerAuth(deps),
    rateLimit: rateLimitMiddleware(deps),
    idempotency: idempotencyMiddleware(deps),
  };
}
