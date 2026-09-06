import type { PoolClient } from "pg";
import type { OrderSide } from "./exchange.js";

/**
 * The SQL behind the five public market data endpoints (spec 10.6) and behind the exchange
 * verify route's document, which lives in src/routes/verify.ts instead since it recomputes
 * a ledger, not a market. Every function here reads only, taking a PoolClient the caller
 * already opened (src/routes/exchange-market-data.ts), the same convention every other
 * read in this codebase follows.
 */

export interface BookLevel { price: string; quantity: string; orders: string }

/**
 * One side of the book, aggregated by price: every open or partially filled order's
 * remaining quantity summed, and the number of orders resting at that price, both spec
 * 10.6's own field list. Bids sort by price descending (best bid first), asks ascending
 * (best ask first); depth bounds how many distinct price levels come back, already
 * validated to 1 to 100 by the route's own query schema before this ever runs.
 */
export async function getBookLevels(c: PoolClient, market: string, side: OrderSide, depth: number): Promise<BookLevel[]> {
  const direction = side === "buy" ? "desc" : "asc";
  const { rows } = await c.query<BookLevel>(
    `select price::text as price, sum(quantity - filled_quantity)::text as quantity, count(*)::text as orders
     from orders
     where market = $1 and side = $2 and status in ('open', 'partially_filled')
     group by price
     order by price ${direction}
     limit $3`,
    [market, side, depth]);
  return rows;
}

export interface PublicTradeRow {
  id: string; market: string; seq: string; price: string; quantity: string; notional: string; created_at: string;
}

/** Recent trades, newest first, spec 10.6. Never names either order or fee (schemas/exchange.ts's PublicTradeOut): a public tape shows the fill itself, not who was on either side of it. */
export async function listPublicTrades(c: PoolClient, market: string, limit: number): Promise<PublicTradeRow[]> {
  const { rows } = await c.query<PublicTradeRow>(
    `select id, market, seq::text as seq, price::text as price, quantity::text as quantity, notional::text as notional, fmt_ts(created_at) as created_at
     from trades
     where market = $1
     order by seq desc
     limit $2`,
    [market, limit]);
  return rows;
}

export interface TickerRow {
  last: string | null; high_24h: string | null; low_24h: string | null;
  base_volume_24h: string | null; quote_volume_24h: string | null;
}

/**
 * Spec 10.6: last price, 24 hour high, low, base volume, quote volume, nulls when no
 * trades. Read as one coherent statement, not "last" unbounded and the rest windowed: a
 * plain aggregate with no group by always answers exactly one row, every column null when
 * zero rows match the window, which is what makes "nulls when no trades" one condition
 * instead of two different ones for "last" and for the four 24 hour figures.
 *
 * now defaults to the real clock in production; the route never passes anything else. It
 * exists as a parameter so tests/integration/market-data.test.ts can ask "what did the
 * ticker look like as of this exact instant" against trades it stamped with an equally
 * exact, deliberately historical created_at, the only way to pin this query's rolling
 * window against a database every other exchange test file is trading on at the same time.
 */
export async function getTicker(c: PoolClient, market: string, now: Date = new Date()): Promise<TickerRow> {
  const { rows } = await c.query<{ last: string | null; high: string | null; low: string | null; base_volume: string | null; quote_volume: string | null }>(
    `select
       (array_agg(price::text order by seq desc))[1] as last,
       max(price)::text as high, min(price)::text as low,
       sum(quantity)::text as base_volume, sum(notional)::text as quote_volume
     from trades
     where market = $1 and created_at > $2::timestamptz - interval '24 hours' and created_at <= $2::timestamptz`,
    [market, now]);
  const r = rows[0];
  return {
    last: r?.last ?? null, high_24h: r?.high ?? null, low_24h: r?.low ?? null,
    base_volume_24h: r?.base_volume ?? null, quote_volume_24h: r?.quote_volume ?? null,
  };
}

export type CandleInterval = "1m" | "5m" | "1h";
const INTERVAL_STRIDE: Record<CandleInterval, string> = { "1m": "1 minute", "5m": "5 minutes", "1h": "1 hour" };

export interface CandleRow { t: string; open: string; high: string; low: string; close: string; volume: string }

/**
 * Open, high, low, close, volume per bucket, aggregated in SQL with date_bin (spec 10.6),
 * newest first, only buckets that actually have a trade in them. The origin (2000-01-01
 * UTC, itself exactly on a minute, an hour and a day boundary) is fixed and arbitrary: it
 * only has to be some fixed instant every bucket aligns to, not any particular one, since
 * date_bin's buckets are stride length intervals counted from it either way.
 *
 * open and close are found the same way, distinct on the bucket, ordered to put the
 * earliest (open) or latest (close) trade first; high, low and volume are plain
 * aggregates over the same bucketed rows. All three read from one CTE so a bucket can never
 * disagree with itself about which trades it contains.
 */
export async function getCandles(c: PoolClient, market: string, interval: CandleInterval, limit: number): Promise<CandleRow[]> {
  const { rows } = await c.query<CandleRow>(
    `with bucketed as (
       select date_bin($1::interval, created_at, timestamptz '2000-01-01 00:00:00+00') as bucket,
              id, price, quantity, created_at
       from trades
       where market = $2
     ),
     agg as (
       select bucket, max(price)::text as high, min(price)::text as low, sum(quantity)::text as volume
       from bucketed
       group by bucket
     ),
     opens as (
       select distinct on (bucket) bucket, price::text as open
       from bucketed
       order by bucket, created_at asc, id asc
     ),
     closes as (
       select distinct on (bucket) bucket, price::text as close
       from bucketed
       order by bucket, created_at desc, id desc
     )
     select fmt_ts(agg.bucket) as t, opens.open, agg.high, agg.low, closes.close, agg.volume
     from agg
     join opens using (bucket)
     join closes using (bucket)
     order by agg.bucket desc
     limit $3`,
    [INTERVAL_STRIDE[interval], market, limit]);
  return rows;
}
