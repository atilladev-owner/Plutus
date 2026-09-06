import type { Pool, PoolClient } from "pg";
import { withTx } from "./pool.js";
import { newId } from "../domain/ids.js";
import { pageOf, type Page, type Paged, type Cursored } from "./ledger.js";

/** The system ledger and key the house trades from, created once by
 * db/migrations/0011_exchange.sql with these exact ids, so later tasks can hard code
 * them instead of looking them up. */
export const EXCHANGE_LEDGER_ID = "ldg_exchange";
export const HOUSE_KEY_ID = "key_house";

export const MARKETS = ["BTC-USDT", "ETH-USDT"] as const;
export type MarketSymbol = (typeof MARKETS)[number];

export interface MarketRow {
  symbol: string;
  base: string;
  quote: string;
  tick_size: string;
  lot_size: string;
  min_notional: string;
  maker_fee_bps: number;
  taker_fee_bps: number;
  status: "open" | "halted";
  house_quoted_at: Date | null;
  reference_price: string | null;
  next_seq: string;
}

/** Wraps lock_markets (db/migrations/0012_exchange_wallet.sql): market advisory locks,
 * always taken in symbol order regardless of how many or which order the caller names them
 * in, spec 10.4 step 7. place_order and cancel_order already take their own single market's
 * lock this way internally; a caller about to touch more than one market itself, the way
 * cancel all (src/routes/exchange-orders.ts) and reset (src/routes/exchange-wallet.ts) can,
 * takes every lock it will need up front, in this same order, before any of the per order
 * calls that would otherwise take them one at a time in whatever order the orders happen to
 * have been created. That is what keeps two transactions that both end up needing more than
 * one market's lock from ever being able to want them in opposite orders. */
export async function lockMarkets(c: PoolClient, symbols: readonly string[]): Promise<void> {
  await c.query("select lock_markets($1::text[])", [symbols]);
}

export async function getMarket(c: PoolClient, symbol: string): Promise<MarketRow | null> {
  const { rows } = await c.query<MarketRow>("select * from markets where symbol = $1", [symbol]);
  return rows[0] ?? null;
}

export async function listMarkets(c: PoolClient): Promise<MarketRow[]> {
  const { rows } = await c.query<MarketRow>("select * from markets order by symbol");
  return rows;
}

export interface ExchangeBalance { asset: string; balance: string; held: string; available: string }

/** A trader's balances in ldg_exchange, one row per asset the key has an account for
 * (db/migrations/0012_exchange_wallet.sql), empty before the first faucet call. */
export async function listExchangeBalances(c: PoolClient, keyId: string): Promise<ExchangeBalance[]> {
  const { rows } = await c.query<{ asset: string; balance: string; held: string }>(
    "select asset, balance::text as balance, held::text as held from accounts where ledger_id = $1 and name = $2 and kind = 'normal' order by asset",
    [EXCHANGE_LEDGER_ID, keyId]);
  return rows.map((r) => ({ ...r, available: (BigInt(r.balance) - BigInt(r.held)).toString() }));
}

interface FunctionResult { event_ids: string[] }

/** Funds the key's three wallets from the world, once per 24 hours; raises faucet_cooldown
 * (mapped by src/db/errors.ts) when called again too soon. */
export async function exchangeFaucet(c: PoolClient, keyId: string): Promise<string[]> {
  const { rows } = await c.query<{ r: FunctionResult }>("select exchange_faucet($1, now()) as r", [keyId]);
  return (rows[0] as { r: FunctionResult }).r.event_ids;
}

/** Releases every open hold the key owns in ldg_exchange and moves each asset balance
 * back to its faucet amount. A no-op for a key that never called the faucet. */
export async function exchangeReset(c: PoolClient, keyId: string): Promise<string[]> {
  const { rows } = await c.query<{ r: FunctionResult }>("select exchange_reset($1, now()) as r", [keyId]);
  return (rows[0] as { r: FunctionResult }).r.event_ids;
}

export type OrderSide = "buy" | "sell";
export type OrderType = "limit" | "market";
export type TimeInForce = "GTC" | "IOC" | "FOK";
export type OrderStatus = "open" | "partially_filled" | "filled" | "cancelled" | "rejected";

export interface OrderRow {
  id: string; key_id: string; market: string; client_order_id: string | null;
  side: OrderSide; type: OrderType; time_in_force: TimeInForce; post_only: boolean;
  price: string | null; quantity: string | null; quote_amount: string | null;
  filled_quantity: string; filled_quote: string; status: OrderStatus;
  hold_id: string | null; accepted_seq: string | null; reject_reason: string | null;
  created_at: string; updated_at: string;
}

export interface TradeRow {
  id: string; market: string; seq: string; buy_order_id: string; sell_order_id: string;
  price: string; quantity: string; notional: string; buyer_fee: string; seller_fee: string;
  transfer_id: string; created_at: string;
}

export interface PlaceOrderInput {
  keyId: string; market: string; clientOrderId: string | null;
  side: OrderSide; type: OrderType; timeInForce: TimeInForce; postOnly: boolean;
  price: string | null; quantity: string | null; quoteAmount: string | null;
}

export interface PlaceOrderResult { order: OrderRow; trades: TradeRow[]; event_ids: string[] }

interface PgLikeError { message?: string; detail?: string }

/**
 * Calls place_order (db/migrations/0013_place_order.sql). Unlike the other wrappers in
 * this file, this one owns its own transactions rather than accepting an already open
 * client, because a rejection needs a second, separate transaction: place_order raises
 * order_rejected rather than returning a rejection object, so the first transaction rolls
 * back and takes every write it attempted with it. record_rejection then runs in its own
 * transaction to write the market_events row and the trader's own event for the rejection,
 * and the original order_rejected error is rethrown unchanged so the caller still sees the
 * reason as detail, mapped to 422 by src/db/errors.ts. Its rejectionEventIds property carries
 * record_rejection's own event ids, since the raised error is what the caller sees, not
 * this function's return value; src/routes/exchange-orders.ts fans those out too.
 *
 * bodyFingerprint (task 5, 0014_order_fingerprint.sql), when not null, is written onto the
 * new order row in the same transaction as the insert: a stable hash of the request body a
 * client_order_id was placed with, so a caller can tell a byte identical replay from a
 * different request reusing the same handle before ever calling this function again.
 */
export interface RejectedOrderError extends Error { detail?: string; rejectionEventIds?: string[] }

export async function placeOrder(
  pool: Pool, input: PlaceOrderInput, now: Date = new Date(), bodyFingerprint: string | null = null,
): Promise<PlaceOrderResult> {
  const orderId = newId("ord");
  try {
    return await withTx(pool, async (c) => {
      const { rows } = await c.query<{ r: PlaceOrderResult }>(
        "select place_order($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,$10::bigint,$11::bigint,$12) as r",
        [input.keyId, orderId, input.market, input.clientOrderId, input.side, input.type, input.timeInForce,
          input.postOnly, input.price, input.quantity, input.quoteAmount, now]);
      const result = (rows[0] as { r: PlaceOrderResult }).r;
      if (bodyFingerprint !== null) {
        await c.query("update orders set body_fingerprint = $1 where id = $2", [bodyFingerprint, result.order.id]);
      }
      return result;
    });
  } catch (err) {
    const e = err as PgLikeError & { rejectionEventIds?: string[] };
    if (e.message === "order_rejected" && e.detail) {
      const { rows } = await withTx(pool, (c) => c.query<{ r: { event_ids: string[] } }>(
        "select record_rejection($1, $2, $3, $4, $5) as r",
        [input.keyId, orderId, input.market, e.detail, now]));
      e.rejectionEventIds = (rows[0] as { r: { event_ids: string[] } }).r.event_ids;
    }
    throw err;
  }
}

export interface CancelOrderResult { order: OrderRow; event_ids: string[] }

/** Calls cancel_order (db/migrations/0013_place_order.sql). A single transaction suffices
 * here: cancelling never needs a second write after a rollback the way a rejection does. */
export async function cancelOrder(c: PoolClient, keyId: string, orderId: string, now: Date = new Date()): Promise<CancelOrderResult> {
  const { rows } = await c.query<{ r: CancelOrderResult }>(
    "select cancel_order($1, $2, $3) as r", [keyId, orderId, now]);
  return (rows[0] as { r: CancelOrderResult }).r;
}

// The reads below back src/routes/exchange-orders.ts (task 5): get one, find by
// client_order_id, list with a status filter, and every open order id for cancel all and
// exchange_reset. Every bigint column (price, quantity, quote_amount, filled_quantity,
// filled_quote, accepted_seq) already arrives as a string, never a number: src/db/pool.ts
// installs a type parser for OID 20 (int8) that keeps it one, the same convention
// order_to_jsonb relies on for place_order and cancel_order's results. created_at and
// updated_at go through fmt_ts so every source of an OrderRow, jsonb built or queried
// straight from the table, formats a timestamp identically. The table alias o is always
// used, including in the WHERE and ORDER BY clauses that reference the real created_at and
// id columns, so a bare "created_at" is never ambiguous with the fmt_ts output column of
// the same name the way tests/integration/matching.test.ts's marketEventsGapless warns a
// text cast one can be.
const ORDER_COLUMNS = `o.id, o.key_id, o.market, o.client_order_id, o.side, o.type, o.time_in_force, o.post_only,
  o.price, o.quantity, o.quote_amount, o.filled_quantity, o.filled_quote, o.status, o.hold_id,
  o.accepted_seq, o.reject_reason, fmt_ts(o.created_at) as created_at, fmt_ts(o.updated_at) as updated_at`;

export async function getOrder(c: PoolClient, keyId: string, orderId: string): Promise<OrderRow | null> {
  const { rows } = await c.query<OrderRow>(`select ${ORDER_COLUMNS} from orders o where o.id = $1 and o.key_id = $2`, [orderId, keyId]);
  return rows[0] ?? null;
}

/** The idempotency lookup task 5 requires: an order under this key already claiming this
 * client_order_id, if any, with the fingerprint it was placed under alongside it so the
 * caller can decide replay from mismatch before ever calling placeOrder again. */
export async function findOrderByClientOrderId(c: PoolClient, keyId: string, clientOrderId: string): Promise<(OrderRow & { body_fingerprint: string | null }) | null> {
  const { rows } = await c.query<OrderRow & { body_fingerprint: string | null }>(
    `select ${ORDER_COLUMNS}, o.body_fingerprint from orders o where o.key_id = $1 and o.client_order_id = $2`,
    [keyId, clientOrderId]);
  return rows[0] ?? null;
}

export async function listOrders(c: PoolClient, keyId: string, page: Page, status: OrderStatus | null): Promise<Paged<OrderRow>> {
  const { rows } = await c.query<Cursored<OrderRow>>(
    `select ${ORDER_COLUMNS}, o.created_at::text as cursor_t from orders o
     where o.key_id = $1 and ($5::text is null or o.status = $5)
       and ($2::timestamptz is null or (o.created_at, o.id) < ($2::timestamptz, $3::text))
     order by o.created_at desc, o.id desc limit $4`,
    [keyId, page.cursor?.t ?? null, page.cursor?.id ?? "", page.limit + 1, status]);
  return pageOf(rows, page.limit);
}

/** Every open or partially filled order id the key owns, oldest first, optionally scoped to
 * one market. Backs cancel all (src/routes/exchange-orders.ts) and the reset handler
 * (src/routes/exchange-wallet.ts), which cancels each one through cancelOrder before
 * releasing anything exchangeReset itself still finds open. */
export async function listOpenOrderIds(c: PoolClient, keyId: string, market: string | null): Promise<string[]> {
  const { rows } = await c.query<{ id: string }>(
    `select id from orders where key_id = $1 and status in ('open', 'partially_filled')
       and ($2::text is null or market = $2)
     order by created_at, id`,
    [keyId, market]);
  return rows.map((r) => r.id);
}

export interface MyTradeRow extends TradeRow { side: OrderSide }

/** Trades where the key was buyer or seller, side always from the key's own point of view.
 * A key is never both (self_trade forbids it), so the case expression is never ambiguous. */
export async function listMyTrades(c: PoolClient, keyId: string, page: Page): Promise<Paged<MyTradeRow>> {
  const { rows } = await c.query<Cursored<MyTradeRow>>(
    `select t.id, t.market, t.seq, t.buy_order_id, t.sell_order_id, t.price, t.quantity, t.notional,
       t.buyer_fee, t.seller_fee, t.transfer_id, fmt_ts(t.created_at) as created_at, t.created_at::text as cursor_t,
       case when bo.key_id = $1 then 'buy' else 'sell' end as side
     from trades t
     join orders bo on bo.id = t.buy_order_id
     join orders so on so.id = t.sell_order_id
     where (bo.key_id = $1 or so.key_id = $1)
       and ($2::timestamptz is null or (t.created_at, t.id) < ($2::timestamptz, $3::text))
     order by t.created_at desc, t.id desc limit $4`,
    [keyId, page.cursor?.t ?? null, page.cursor?.id ?? "", page.limit + 1]);
  return pageOf(rows, page.limit);
}
