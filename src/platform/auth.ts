import { createHash, randomBytes } from "node:crypto";
import type { RequestHandler } from "express";
import { ApiError, unauthorized } from "../domain/errors.js";
import { findKeyBySecretHash, touchKey } from "../db/keys.js";
import { disabledEndpoints } from "../db/webhooks.js";
import type { AppDeps } from "../deps.js";
import type { RouteDef, AuthedKey } from "./route.js";
export type { AuthedKey } from "./route.js";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// 32 random bytes need exactly 43 base62 digits (62^43 exceeds 2^256); left pad with the
// alphabet's zero character so a draw with leading zero digits never yields a short secret.
function base62(bytes: Buffer): string {
  let n = BigInt("0x" + bytes.toString("hex"));
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 62n)] + out; n /= 62n; }
  return out.padStart(43, ALPHABET[0]);
}

export function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function generateSecret(mode: "test" | "live"): { secret: string; hash: Buffer; prefix: string; last4: string } {
  const prefix = mode === "live" ? "pl_live" : "pl_test";
  const secret = `${prefix}_${base62(randomBytes(32))}`;
  return { secret, hash: hashSecret(secret), prefix, last4: secret.slice(-4) };
}

const SECRET_RE = /^pl_(test|live)_[0-9A-Za-z]{43}$/;

export function bearerAuth(deps: AppDeps) {
  return (def: RouteDef): RequestHandler => async (req, res, next) => {
    try {
      if (def.auth === "none") return next();
      const header = req.header("authorization") ?? "";
      const [scheme, token] = header.split(" ");
      if (scheme !== "Bearer" || !token || !SECRET_RE.test(token)) throw unauthorized();
      const hash = hashSecret(token);
      const client = await deps.pool.connect();
      let key: AuthedKey | null = null;
      try {
        // The lookup below is by hash equality, in Postgres; a presented secret whose hash
        // does not match any row simply returns no row. There is nothing left to compare
        // once the row is found, so no second (and misleading) timingSafeEqual against the
        // hash we just looked up by.
        const row = await findKeyBySecretHash(client, hash);
        if (row) {
          key = { id: row.id, mode: row.mode, scopes: row.scopes, prefix: row.prefix, last4: row.last4 };
          await touchKey(client, row.id);
          const disabled = await disabledEndpoints(client, row.id);
          if (disabled.length > 0) res.setHeader("Plutus-Warning", `disabled webhook endpoints: ${disabled.join(",")}`);
        }
      } finally {
        client.release();
      }
      if (!key) throw unauthorized();
      if (def.scope && !key.scopes.includes(def.scope)) throw new ApiError(403, "forbidden_scope", `this key lacks the ${def.scope} scope`);
      res.locals.key = key;
      next();
    } catch (err) {
      next(err);
    }
  };
}
