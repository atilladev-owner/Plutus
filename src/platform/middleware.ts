import type { AppDeps } from "../deps.js";
import type { RouteDef, RouteMiddleware } from "./route.js";
import { bearerAuth } from "./auth.js";
import { signedAuth } from "./signing.js";
import { rateLimitMiddleware } from "./ratelimit.js";
import { weightLimit } from "./weights.js";
import { idempotencyMiddleware } from "./idempotency.js";

export function productionMiddleware(deps: AppDeps): RouteMiddleware {
  const bearer = bearerAuth(deps);
  const signed = signedAuth(deps);
  const standardRateLimit = rateLimitMiddleware(deps);
  const weight = weightLimit(deps);
  return {
    // "signed" routes authenticate with signedAuth (spec 10.8) and pay endpoint weights
    // (spec 10.9) instead of the per key sandbox/live limiter; every other route keeps
    // milestone one's bearer token and rate limit behaviour unchanged.
    auth: (def: RouteDef) => (def.auth === "signed" ? signed(def) : bearer(def)),
    rateLimit: (def: RouteDef) => (def.auth === "signed" ? weight(def) : standardRateLimit(def)),
    idempotency: idempotencyMiddleware(deps),
  };
}
