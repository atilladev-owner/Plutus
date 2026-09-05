import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { ApiError, validation } from "../domain/errors.js";
import { canonicalJson, type JsonValue } from "../domain/canonical.js";
import { claim, complete, abandon } from "../db/idempotency.js";
import type { AppDeps } from "../deps.js";
import type { RouteDef, AuthedKey } from "./route.js";

export function idempotencyMiddleware(deps: AppDeps) {
  return (def: RouteDef): RequestHandler => async (req, res, next) => {
    try {
      const idem = req.header("idempotency-key");
      const key = res.locals.key as AuthedKey | undefined;
      if (!def.idempotent || !idem || !key) return next();
      if (idem.length > 255) throw validation("Idempotency-Key must be 1 to 255 characters");
      let bodyCanonical = "";
      try { bodyCanonical = canonicalJson((req.body ?? {}) as JsonValue); } catch { bodyCanonical = JSON.stringify(req.body ?? {}); }
      const fingerprint = createHash("sha256").update(`${req.method}\n${req.path}\n${bodyCanonical}`).digest();
      const client = await deps.pool.connect();
      let claimed = false;
      try {
        const r = await claim(client, key.id, idem, fingerprint);
        claimed = r.claimed;
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
      // Capture the response this request produces and store it.
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        const status = res.statusCode;
        void (async () => {
          const c = await deps.pool.connect();
          try { if (status < 500) await complete(c, key.id, idem, status, body); else await abandon(c, key.id, idem); } finally { c.release(); }
        })().catch((err: unknown) => deps.logger.error({ err: (err as Error).message }, "idempotency store failed"));
        return originalJson(body);
      }) as typeof res.json;
      res.on("close", () => {
        if (claimed && !res.writableFinished) void deps.pool.connect().then((c) => abandon(c, key.id, idem).finally(() => c.release()));
      });
      next();
    } catch (err) {
      next(err);
    }
  };
}
