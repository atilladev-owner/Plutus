import { createHmac } from "node:crypto";
import type { RequestHandler } from "express";
import { ApiError } from "../domain/errors.js";
import { hashSecret, safeEqual } from "./auth.js";
import { getKey, touchKey, listActiveOldSecretHashes } from "../db/keys.js";
import { disabledEndpoints } from "../db/webhooks.js";
import type { AppDeps } from "../deps.js";
import type { RouteDef, AuthedKey } from "./route.js";

/**
 * Trading endpoints sign every request instead of sending a bearer token (spec 10.8).
 *
 * The HMAC key is not the raw secret. api_keys never stores the raw secret, only
 * secret_hash, the unsalted SHA256 digest hashSecret computes in auth.ts; the server has
 * no raw secret to key an HMAC with. So both sides key the HMAC with that digest: the
 * server reads secret_hash straight off the row, and the client (signRequest here) hashes
 * its own secret with the same hashSecret before signing. That is why signRequest takes
 * `secret`, the raw pl_test_ or pl_live_ string, rather than a ready made key.
 */

export const DEFAULT_RECV_WINDOW_MS = 5000;
export const MAX_RECV_WINDOW_MS = 60_000;

export interface SignRequestInput {
  keyId: string;
  secret: string;
  method: string;
  /** The request path including the query string, exactly as it will be sent. */
  path: string;
  /** Raw request body bytes as a string. Omit, or pass "", for a bodyless request. */
  body?: string;
  timestamp: number;
  recvWindow?: number;
}

/** A plain string record, not a literal-keyed interface, because supertest's `.set()`
 * (and any other HTTP client) wants an index-signed headers object to spread these into. */
export type SignedRequestHeaders = Record<string, string>;

function signatureMessage(timestamp: number, method: string, path: string, body: string): string {
  return `${timestamp}\n${method.toUpperCase()}\n${path}\n${body}`;
}

/**
 * Never a real hash, just 32 zero bytes the same length as one: HMACing this and running
 * safeEqual against the result on the "no active row" path costs the same as verifying a
 * real key's signature. Without it, an unknown, revoked or expired key id would answer
 * faster than a wrong signature against a real key, since neither the HMAC nor the compare
 * would ever run, and that timing gap would let ids be enumerated even though both cases
 * already return the identical 401 invalid_signature body.
 */
const DUMMY_HMAC_KEY = Buffer.alloc(32);

/** Builds the four signed request headers (spec 10.8). Used by tests and by the owner's
 * docs/place-order.mjs script, so both sign requests exactly the way the server verifies them. */
export function signRequest(input: SignRequestInput): SignedRequestHeaders {
  const { keyId, secret, method, path, body = "", timestamp, recvWindow = DEFAULT_RECV_WINDOW_MS } = input;
  const key = hashSecret(secret);
  const message = signatureMessage(timestamp, method, path, body);
  const signature = createHmac("sha256", key).update(message, "utf8").digest("hex");
  return {
    "X-Plutus-Key-Id": keyId,
    "X-Plutus-Timestamp": String(timestamp),
    "X-Plutus-Recv-Window": String(recvWindow),
    "X-Plutus-Signature": signature,
  };
}

/** Undefined keeps the default; anything else is clamped to the 0..60,000ms range the
 * spec allows, so a caller cannot buy itself an unbounded replay window with a huge value. */
function resolveRecvWindow(header: string | undefined): number {
  if (header === undefined) return DEFAULT_RECV_WINDOW_MS;
  const n = Number(header);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RECV_WINDOW_MS;
  return Math.min(n, MAX_RECV_WINDOW_MS);
}

export function signedAuth(deps: AppDeps) {
  return (def: RouteDef): RequestHandler => async (req, res, next) => {
    try {
      if (def.auth !== "signed") return next();
      const keyId = req.header("x-plutus-key-id");
      const timestampHeader = req.header("x-plutus-timestamp");
      const signature = req.header("x-plutus-signature");
      if (!keyId || !timestampHeader || !signature) {
        throw new ApiError(401, "invalid_signature", "a signed request needs Key-Id, Timestamp and Signature headers");
      }
      const timestamp = Number(timestampHeader);
      if (!Number.isFinite(timestamp)) throw new ApiError(401, "invalid_signature", "the timestamp header is not a number");
      const recvWindow = resolveRecvWindow(req.header("x-plutus-recv-window"));
      const age = Date.now() - timestamp;
      // Symmetric: a timestamp too far in the future is out of window exactly like one
      // too far in the past, not just accepted because it has not "expired" yet.
      if (age > recvWindow || age < -recvWindow) {
        throw new ApiError(401, "timestamp_out_of_window", "the request timestamp is outside the receive window");
      }

      const client = await deps.pool.connect();
      let key: AuthedKey | null = null;
      try {
        // Looked up by id, not by hash: unlike bearerAuth there is no hash to look up by
        // until the signature itself is checked. A missing row and a wrong signature both
        // fall through to the same invalid_signature 401 below, so an id cannot be probed
        // by response body or status; the dummy compare below closes the same gap for
        // response timing.
        const row = await getKey(client, keyId);
        const active = row && row.revoked_at === null && (row.expires_at === null || row.expires_at > new Date()) ? row : null;
        const path = req.originalUrl;
        const body = req.rawBody ? req.rawBody.toString("utf8") : "";
        const message = signatureMessage(timestamp, req.method, path, body);
        if (active) {
          let matched = safeEqual(createHmac("sha256", active.secret_hash).update(message, "utf8").digest("hex"), signature);
          let usedOldSecret = false;
          // The current secret failed; a rotation may still leave an old one valid for
          // fifteen more minutes (rotateKey, db/keys.ts). Tried in order, newest first,
          // with safeEqual for every compare, same as the current secret above.
          if (!matched) {
            const oldHashes = await listActiveOldSecretHashes(client, active.id);
            for (const oldHash of oldHashes) {
              const candidate = createHmac("sha256", oldHash).update(message, "utf8").digest("hex");
              if (safeEqual(candidate, signature)) { matched = true; usedOldSecret = true; break; }
            }
          }
          if (matched) {
            key = { id: active.id, mode: active.mode, scopes: active.scopes, prefix: active.prefix, last4: active.last4 };
            await touchKey(client, active.id);
            const disabled = await disabledEndpoints(client, active.id);
            const warnings: string[] = [];
            if (usedOldSecret) warnings.push("signed with a rotated secret still inside its grace period");
            if (disabled.length > 0) warnings.push(`disabled webhook endpoints: ${disabled.join(",")}`);
            if (warnings.length > 0) res.setHeader("Plutus-Warning", warnings.join("; "));
          }
        } else {
          // No active row for this id: still spend one HMAC and one safeEqual, against a
          // fixed dummy key that can never match, so this path takes the same time as a
          // real key's failed comparison above.
          safeEqual(createHmac("sha256", DUMMY_HMAC_KEY).update(message, "utf8").digest("hex"), signature);
        }
      } finally {
        client.release();
      }
      if (!key) throw new ApiError(401, "invalid_signature", "the signature does not match");
      if (def.scope && !key.scopes.includes(def.scope)) throw new ApiError(403, "forbidden_scope", `this key lacks the ${def.scope} scope`);
      res.locals.key = key;
      next();
    } catch (err) {
      next(err);
    }
  };
}
