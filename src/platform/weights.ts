import type { RequestHandler } from "express";
import { ApiError } from "../domain/errors.js";
import type { AppDeps } from "../deps.js";
import type { RouteDef, AuthedKey } from "./route.js";
import { limitWithTimeout, applyRateLimitHeaders } from "./ratelimit.js";

/**
 * Endpoint weights (spec 10.9). A signed call spends def.weight out of the 1,200 per
 * minute budget kept for the calling key; order placement additionally spends one point
 * a second out of its own ten per second cap, so a burst of cheap placements cannot dodge
 * the per second limit just because it fits comfortably under the per minute one.
 *
 * This is the "rateLimit" slot of the middleware chain for a "signed" route (wired in
 * middleware.ts); "auth" runs first in that chain and always sets res.locals.key on
 * success, so key is never missing by the time this runs.
 */
export function weightLimit(deps: AppDeps) {
  return (def: RouteDef): RequestHandler => async (req, res, next) => {
    try {
      const key = res.locals.key as AuthedKey | undefined;
      if (!key) throw new ApiError(401, "invalid_signature", "a signed request is required");
      const weightResult = await limitWithTimeout(deps, "weight", key.id, def.weight ?? 1);
      const weightReset = applyRateLimitHeaders(res, weightResult);
      if (!weightResult.ok) {
        throw new ApiError(429, "rate_limited", `limit of ${weightResult.limit} per window reached`, undefined, { "Retry-After": String(weightReset) });
      }
      if (def.placement) {
        const placeResult = await limitWithTimeout(deps, "place", key.id);
        const placeReset = applyRateLimitHeaders(res, placeResult);
        if (!placeResult.ok) {
          throw new ApiError(429, "rate_limited", `limit of ${placeResult.limit} per window reached`, undefined, { "Retry-After": String(placeReset) });
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
