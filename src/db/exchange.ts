import type { PoolClient } from "pg";

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
