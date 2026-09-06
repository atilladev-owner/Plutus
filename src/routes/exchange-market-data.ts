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

async function readCache<T>(deps: AppDeps, key: string): Promise<T | null> {
  const hit = await deps.cache.get(key);
  return hit === null ? null : (JSON.parse(hit) as T);
}

async function writeCache(deps: AppDeps, key: string, value: unknown): Promise<void> {
  await deps.cache.set(key, JSON.stringify(value), CACHE_TTL_SECONDS);
}

/** 404s an unknown symbol; a well shaped but nonexistent one (MarketSymbol's regex only
 * checks the BASE-QUOTE shape) reaches here rather than being caught by params validation. */
async function requireMarket(deps: AppDeps, symbol: string): Promise<void> {
  const market = await withTx(deps.pool, (c) => X.getMarket(c, symbol));
  if (!market) throw notFound("market");
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
      await requireMarket(deps, params.symbol);
      // Spec 10.5: a book read is one of the moments the house looks, so its own ladder on
      // this market is refreshed first, before the book itself is read, when stale.
      await ensureFreshLadder(deps, params.symbol);
      const document = await withTx(deps.pool, async (c) => {
        const market = await X.getMarket(c, params.symbol);
        if (!market) throw notFound("market");
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
      await requireMarket(deps, params.symbol);
      await ensureFreshLadder(deps, params.symbol);
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
      await requireMarket(deps, params.symbol);
      await ensureFreshLadder(deps, params.symbol);
      const document = await withTx(deps.pool, async (c) => {
        const market = await X.getMarket(c, params.symbol);
        if (!market) throw notFound("market");
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
      await requireMarket(deps, params.symbol);
      await ensureFreshLadder(deps, params.symbol);
      const document = await withTx(deps.pool, async (c) => ({ data: await M.getCandles(c, params.symbol, query.interval, query.limit) }));
      await writeCache(deps, cacheKey, document);
      return document;
    },
  }),
  defineRoute({
    method: "get", path: "/v1/exchange/verify", summary: "The public proof that the exchange cannot create or destroy money", tag: "Exchange",
    auth: "none", limit: "verify_public", response: VerifyReportOut,
    handler: async ({ deps }) => withTx(deps.pool, async (c) => {
      // key_house owns ldg_exchange (db/migrations/0011_exchange.sql), and getLedger's
      // lookup is by (id, key_id) equality, so this is the same lookup ownLedger does for
      // the signed, per key verify route, just against the one key that actually owns this
      // one fixed ledger. Not IdParam("ldg"): ldg_exchange does not match its 32 hex shape
      // (task 1 review note), so this route names the ledger directly rather than through a
      // path parameter at all.
      const ledger = await L.getLedger(c, X.HOUSE_KEY_ID, X.EXCHANGE_LEDGER_ID);
      if (!ledger) throw notFound("ledger");
      return verifyLedgerReport(c, deps, ledger.id, ledger.next_seq);
    }),
  }),
];
