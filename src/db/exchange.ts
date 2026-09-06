import type { Pool, PoolClient } from "pg";
import { withTx } from "./pool.js";
import { newId } from "../domain/ids.js";

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
 * reason as detail, mapped to 422 by src/db/errors.ts.
 */
export async function placeOrder(pool: Pool, input: PlaceOrderInput, now: Date = new Date()): Promise<PlaceOrderResult> {
  const orderId = newId("ord");
  try {
    return await withTx(pool, async (c) => {
      const { rows } = await c.query<{ r: PlaceOrderResult }>(
        "select place_order($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,$10::bigint,$11::bigint,$12) as r",
        [input.keyId, orderId, input.market, input.clientOrderId, input.side, input.type, input.timeInForce,
          input.postOnly, input.price, input.quantity, input.quoteAmount, now]);
      return (rows[0] as { r: PlaceOrderResult }).r;
    });
  } catch (err) {
    const e = err as PgLikeError;
    if (e.message === "order_rejected" && e.detail) {
      await withTx(pool, (c) => c.query(
        "select record_rejection($1, $2, $3, $4, $5)",
        [input.keyId, orderId, input.market, e.detail, now]));
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
