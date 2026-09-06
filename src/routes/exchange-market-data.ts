import { z } from "zod";
import { defineRoute } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { notFound } from "../domain/errors.js";
import { ensureFreshLadder } from "./exchange-house.js";
import { verifyLedgerReport, VerifyReportOut } from "./verify.js";
import * as X from "../db/exchange.js";
import * as L from "../db/ledger.js";
import * as M from "../db/market-data.js";
import {
  MarketSymbol, MarketsOut, BookOut, PublicTradesOut, TickerOut, CandleInterval, CandlesOut,
} from "../schemas/exchange.js";
import type { AppDeps } from "../deps.js";

/**
 * The five public market data endpoints, spec 10.6, plus the public proof at the bottom of
 * this file. Every one of the five reads is cached in deps.cache for two seconds under a
 * key naming its own path and query string, checked before anything else runs: a hit never
 * touches ensureFreshLadder (spec 10.5) or a single row of SQL, which is what lets
 * tests/integration/market-data.test.ts prove a second read inside the window runs no
 * further queries. A miss checks the market exists (404 not_found otherwise), refreshes the
 * house ladder if it is stale, then reads and caches the document.
 */

const CACHE_TTL_SECONDS = 2;

/**
 * The cache is never the source of truth (spec 10.6 only ever calls it an optimisation), so
 * neither side of it is allowed to turn a public read into a 500: a get failure is treated
 * as a plain miss, a set failure is swallowed outright, and either is logged rather than
 * thrown. tests/integration/market-data.test.ts proves this with a fake cache whose get
 * (and set) throw, asserting the route still answers 200 with the real, freshly read
 * document.
 */
async function readCache<T>(deps: AppDeps, key: string): Promise<T | null> {
  try {
    const hit = await deps.cache.get(key);
    return hit === null ? null : (JSON.parse(hit) as T);
  } catch (err) {
    deps.logger.warn({ err: (err as Error).message, key }, "market data cache read failed; treating as a miss");
    return null;
  }
}

async function writeCache(deps: AppDeps, key: string, value: unknown): Promise<void> {
  try {
    await deps.cache.set(key, JSON.stringify(value), CACHE_TTL_SECONDS);
  } catch (err) {
    deps.logger.warn({ err: (err as Error).message, key }, "market data cache write failed; answering uncached");
  }
}

/** 404s an unknown symbol (a well shaped but nonexistent one, MarketSymbol's regex only
 * checks the BASE-QUOTE shape, reaches here rather than being caught by params validation),
 * otherwise returns the row so a caller that also wants it (book, ticker) never fetches the
 * same market twice. Always called after ensureFreshLadder, not before, so the row this
 * returns, and the seq a caller reads off it, reflect any house ladder that call just
 * refreshed rather than the market's state a moment before it. */
async function requireMarket(deps: AppDeps, symbol: string): Promise<X.MarketRow> {
  const market = await withTx(deps.pool, (c) => X.getMarket(c, symbol));
  if (!market) throw notFound("market");
  return market;
}

/** The market's current sequence position, spec 10.6's "seq": next_seq is the sequence the
 * next market event will be assigned, one past the last one actually written. */
function currentSeq(m: X.MarketRow): string {
  return (BigInt(m.next_seq) - 1n).toString();
}

function marketOut(m: X.MarketRow) {
  return {
    symbol: m.symbol, base: m.base, quote: m.quote,
    tick_size: m.tick_size, lot_size: m.lot_size, min_notional: m.min_notional,
    maker_fee_bps: m.maker_fee_bps, taker_fee_bps: m.taker_fee_bps, status: m.status,
    seq: currentSeq(m), reference_price: m.reference_price,
    house_quoted_at: m.house_quoted_at ? m.house_quoted_at.toISOString() : null,
  };
}

const SymbolParam = z.object({ symbol: MarketSymbol });
const BookQuery = z.object({ depth: z.coerce.number().int().min(1).max(100).default(20) });
const TradesQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const CandlesQuery = z.object({ interval: CandleInterval, limit: z.coerce.number().int().min(1).max(500).default(100) });

export const exchangeMarketDataRoutes = [
  defineRoute({
    method: "get", path: "/v1/exchange/markets", summary: "List every market", tag: "Exchange",
    auth: "none", response: MarketsOut,
    handler: async ({ req, deps }) => {
      const cacheKey = `md:${req.originalUrl}`;
      const hit = await readCache<z.infer<typeof MarketsOut>>(deps, cacheKey);
      if (hit) return hit;
      const markets = await withTx(deps.pool, (c) => X.listMarkets(c));
      const document = { data: markets.map(marketOut) };
      await writeCache(deps, cacheKey, document);
      return document;
    },
  }),
  defineRoute({
    method: "get", path: "/v1/exchange/markets/{symbol}/book", summary: "The order book, aggregated by price", tag: "Exchange",
    auth: "none", limit: "weight", weight: 5,
    params: SymbolParam, query: BookQuery, response: BookOut,
    handler: async ({ req, deps, params, query }) => {
      const cacheKey = `md:${req.originalUrl}`;
      const hit = await readCache<z.infer<typeof BookOut>>(deps, cacheKey);
      if (hit) return hit;
      // Spec 10.5: a book read is one of the moments the house looks, so its own ladder on
      // this market is refreshed first, before the book itself, and before the market row
      // requireMarket below reads for seq, both of which should reflect it when it runs.
      // ensureFreshLadder is a no-op for a symbol that turns out not to exist, so calling it
      // ahead of the existence check costs nothing on the 404 path either.
      await ensureFreshLadder(deps, params.symbol);
      const market = await requireMarket(deps, params.symbol);
      const document = await withTx(deps.pool, async (c) => {
        const bids = await M.getBookLevels(c, params.symbol, "buy", query.depth);
        const asks = await M.getBookLevels(c, params.symbol, "sell", query.depth);
        return { market: params.symbol, seq: currentSeq(market), bids, asks };
      });
      await writeCache(deps, cacheKey, document);
      return document;
    },
  }),
  defineRoute({
    method: "get", path: "/v1/exchange/markets/{symbol}/trades", summary: "Recent trades, newest first", tag: "Exchange",
    auth: "none", limit: "weight", weight: 5,
    params: SymbolParam, query: TradesQuery, response: PublicTradesOut,
    handler: async ({ req, deps, params, query }) => {
      const cacheKey = `md:${req.originalUrl}`;
      const hit = await readCache<z.infer<typeof PublicTradesOut>>(deps, cacheKey);
      if (hit) return hit;
      await ensureFreshLadder(deps, params.symbol);
      await requireMarket(deps, params.symbol);
      const document = await withTx(deps.pool, async (c) => ({ data: await M.listPublicTrades(c, params.symbol, query.limit) }));
      await writeCache(deps, cacheKey, document);
      return document;
    },
  }),
  defineRoute({
    method: "get", path: "/v1/exchange/markets/{symbol}/ticker", summary: "Last price, 24 hour high, low and volume", tag: "Exchange",
    auth: "none", limit: "weight", weight: 5,
    params: SymbolParam, response: TickerOut,
    handler: async ({ req, deps, params }) => {
      const cacheKey = `md:${req.originalUrl}`;
      const hit = await readCache<z.infer<typeof TickerOut>>(deps, cacheKey);
      if (hit) return hit;
      await ensureFreshLadder(deps, params.symbol);
      const market = await requireMarket(deps, params.symbol);
      const document = await withTx(deps.pool, async (c) => {
        const ticker = await M.getTicker(c, params.symbol);
        return { market: params.symbol, seq: currentSeq(market), ...ticker };
      });
      await writeCache(deps, cacheKey, document);
      return document;
    },
  }),
  defineRoute({
    method: "get", path: "/v1/exchange/markets/{symbol}/candles", summary: "OHLCV candles bucketed from trades", tag: "Exchange",
    auth: "none", limit: "weight", weight: 10,
    params: SymbolParam, query: CandlesQuery, response: CandlesOut,
    handler: async ({ req, deps, params, query }) => {
      const cacheKey = `md:${req.originalUrl}`;
      const hit = await readCache<z.infer<typeof CandlesOut>>(deps, cacheKey);
      if (hit) return hit;
      await ensureFreshLadder(deps, params.symbol);
      await requireMarket(deps, params.symbol);
      const document = await withTx(deps.pool, async (c) => ({ data: await M.getCandles(c, params.symbol, query.interval, query.limit) }));
      await writeCache(deps, cacheKey, document);
      return document;
    },
  }),
  defineRoute({
    method: "get", path: "/v1/exchange/verify", summary: "The public proof that the exchange cannot create or destroy money", tag: "Exchange",
    auth: "none", limit: "verify_public", response: VerifyReportOut,
    handler: async ({ deps }) => {
      // key_house owns ldg_exchange (db/migrations/0011_exchange.sql), and getLedger's
      // lookup is by (id, key_id) equality, so this is the same lookup ownLedger does for
      // the signed, per key verify route, just against the one key that actually owns this
      // one fixed ledger. Not IdParam("ldg"): ldg_exchange does not match its 32 hex shape
      // (task 1 review note), so this route names the ledger directly rather than through a
      // path parameter at all.
      const ledger = await withTx(deps.pool, (c) => L.getLedger(c, X.HOUSE_KEY_ID, X.EXCHANGE_LEDGER_ID));
      if (!ledger) throw notFound("ledger");
      return verifyLedgerReport(deps, ledger.id, ledger.next_seq);
    },
  }),
];
