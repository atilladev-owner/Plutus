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
