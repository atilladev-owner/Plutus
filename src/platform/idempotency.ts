import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { ApiError, validation } from "../domain/errors.js";
import { stableJson } from "../domain/canonical.js";
import { claim, abandon } from "../db/idempotency.js";
import type { AppDeps } from "../deps.js";
import type { RouteDef, AuthedKey } from "./route.js";

export function idempotencyMiddleware(deps: AppDeps) {
  return (def: RouteDef): RequestHandler => async (req, res, next) => {
    try {
      const idem = req.header("idempotency-key");
      const key = res.locals.key as AuthedKey | undefined;
      if (!def.idempotent || !idem || !key) return next();
      if (idem.length > 255) throw validation("Idempotency-Key must be 1 to 255 characters");
      const fingerprint = createHash("sha256").update(`${req.method}\n${req.path}\n${stableJson(req.body ?? null)}`).digest();
      const client = await deps.pool.connect();
      try {
        const r = await claim(client, key.id, idem, fingerprint);
        if (!r.claimed) {
          if (!timingSafeEqual(r.row.fingerprint, fingerprint)) throw new ApiError(409, "idempotency_key_reused", "this Idempotency-Key was already used with a different request");
          if (r.row.status === "pending") throw new ApiError(409, "idempotency_in_flight", "a request with this Idempotency-Key is still being processed");
          res.setHeader("Idempotent-Replayed", "true");
          res.status(r.row.response_status ?? 200).json(r.row.response_body);
          return;
        }
      } finally {
        client.release();
      }
      // mountRoutes stores the answer (see src/platform/route.ts) and flips stored to true
      // before it ever sends the response, so a replay can never observe "pending" for a
      // request that already finished. Whichever of these two events fires first releases
      // the claim exactly once: a normal error response (sendProblem uses res.send, never
      // res.json, so stored stays false) on "finish", or a dropped connection on "close".
      // Node always emits "close" after "finish" too, so the guard flag keeps this from
      // running twice on the ordinary path.
      res.locals.idem = { keyId: key.id, idemKey: idem, stored: false };
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (res.locals.idem?.stored) return;
        void (async () => {
          const c = await deps.pool.connect();
          try { await abandon(c, key.id, idem); } finally { c.release(); }
        })().catch((err: unknown) => deps.logger.error({ err: (err as Error).message }, "idempotency release failed"));
      };
      res.on("finish", release);
      res.on("close", release);
      next();
    } catch (err) {
      next(err);
    }
  };
}
