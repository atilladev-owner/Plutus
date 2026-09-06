import { ApiError, type ErrorCode } from "../domain/errors.js";

interface PgLikeError { message?: string; detail?: string; code?: string }

const RAISED: Record<string, { status: number; code: ErrorCode }> = {
  insufficient_funds: { status: 409, code: "insufficient_funds" },
  asset_mismatch: { status: 422, code: "asset_mismatch" },
  hold_not_open: { status: 409, code: "hold_not_open" },
  hold_not_found: { status: 404, code: "not_found" },
  account_not_found: { status: 404, code: "not_found" },
  ledger_not_found: { status: 404, code: "not_found" },
  validation_failed: { status: 422, code: "validation_failed" },
  sandbox_limit_reached: { status: 409, code: "sandbox_limit_reached" },
};

/** Turns an exception raised by our SQL functions into an ApiError. Anything else returns null. */
export function mapDbError(err: unknown): ApiError | null {
  const e = err as PgLikeError;
  if (typeof e?.message !== "string") return null;
  // exchange_faucet (db/migrations/0012_exchange_wallet.sql) raises this with the whole
  // seconds still remaining in its detail, so the Retry-After header and the RAISED table's
  // plain status/code mapping cannot share one branch the way every other raised code does.
  if (e.message === "faucet_cooldown") {
    const seconds = e.detail && /^[1-9][0-9]*$/.test(e.detail) ? e.detail : "1";
    return new ApiError(429, "faucet_cooldown", "the faucet can be used once every 24 hours", undefined, { "Retry-After": seconds });
  }
  const hit = RAISED[e.message];
  if (!hit) return null;
  const detail = e.detail ? `${e.message.replaceAll("_", " ")}: ${e.detail}` : e.message.replaceAll("_", " ");
  return new ApiError(hit.status, hit.code, detail);
}
