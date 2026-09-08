import { ApiError, type ErrorCode } from "../domain/errors.js";

interface PgLikeError { message?: string; detail?: string; code?: string; constraint?: string }

const RAISED: Record<string, { status: number; code: ErrorCode }> = {
  insufficient_funds: { status: 409, code: "insufficient_funds" },
  asset_mismatch: { status: 422, code: "asset_mismatch" },
  hold_not_open: { status: 409, code: "hold_not_open" },
  hold_not_found: { status: 404, code: "not_found" },
  account_not_found: { status: 404, code: "not_found" },
  ledger_not_found: { status: 404, code: "not_found" },
  validation_failed: { status: 422, code: "validation_failed" },
  sandbox_limit_reached: { status: 409, code: "sandbox_limit_reached" },
  order_not_found: { status: 404, code: "not_found" },
  order_not_open: { status: 409, code: "order_not_open" },
};

/** The two per key cooldowns, exchange_faucet (db/migrations/0012_exchange_wallet.sql) and
 * exchange_reset_cooldown (0018_reset_cooldown.sql). Both raise with the whole seconds still
 * remaining in the detail, so both answer 429 with a Retry-After header, which the RAISED
 * table below cannot express: it maps a status and a code and nothing else. */
const COOLDOWNS: Record<string, { code: ErrorCode; detail: string }> = {
  faucet_cooldown: { code: "faucet_cooldown", detail: "the faucet can be used once every 24 hours" },
  reset_cooldown: { code: "reset_cooldown", detail: "the reset can be used once every 60 seconds" },
};

/** Turns an exception raised by our SQL functions into an ApiError. Anything else returns null. */
export function mapDbError(err: unknown): ApiError | null {
  const e = err as PgLikeError;
  if (typeof e?.message !== "string") return null;
  const cooldown = COOLDOWNS[e.message];
  if (cooldown) {
    const seconds = e.detail && /^[1-9][0-9]*$/.test(e.detail) ? e.detail : "1";
    return new ApiError(429, cooldown.code, cooldown.detail, undefined, { "Retry-After": seconds });
  }
  // place_order (db/migrations/0013_place_order.sql, amended by 0016_house_ladder.sql's
  // notional_too_large) raises this with detail set to one of the ten named reasons in
  // spec 10.3. The reason is exposed verbatim as the error's
  // detail, rather than folded into a human sentence the way the generic RAISED table
  // below does, so a caller can match on it exactly.
  if (e.message === "order_rejected") {
    return new ApiError(422, "order_rejected", e.detail ?? "order_rejected");
  }
  // place_order checks for a duplicate client_order_id before inserting, but two orders for
  // the same key and the same client_order_id on two different markets take two different
  // markets' advisory locks and can race each other right through that check; whichever one
  // commits second hits orders_client_order_idx (0011_exchange.sql) instead, as a raw
  // Postgres unique violation rather than our own raised order_rejected. Mapped here so the
  // cross market race answers exactly the same way the single market case already does.
  if (e.code === "23505" && e.constraint === "orders_client_order_idx") {
    return new ApiError(422, "order_rejected", "duplicate_client_order_id");
  }
  const hit = RAISED[e.message];
  if (!hit) return null;
  const detail = e.detail ? `${e.message.replaceAll("_", " ")}: ${e.detail}` : e.message.replaceAll("_", " ");
  return new ApiError(hit.status, hit.code, detail);
}
