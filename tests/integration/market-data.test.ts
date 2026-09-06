import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import request from "supertest";
import type { Pool } from "pg";
import { testPool } from "../helpers/db.js";
import { makeTestApp } from "../helpers/app.js";
import { withTx } from "../../src/db/pool.js";
import { newId } from "../../src/domain/ids.js";
import * as M from "../../src/db/market-data.js";
import type { Cache } from "../../src/platform/cache.js";

// The public market data endpoints, spec 10.6, and the public proof, spec 10.6's last row.
// The book, trades, ticker and candle scenarios below insert orders and trades directly
// with plain SQL rather than through place_order: this task is about the new read side
// (src/db/market-data.ts) and the routes wrapped around it, and place_order's own matching
// is already exhaustively covered by tests/integration/matching.test.ts. Going around it
// here also sidesteps something that matching, run for real, cannot avoid: this database is
// shared with every other exchange test file and the house's own ladder, running
// concurrently on the very same two markets (vitest.config.ts's fileParallelism), so a real
// order placed at any price is free to cross whatever any of them happens to have resting
// at that exact moment. Reading and writing the same tables place_order itself would
// (orders, trades, and a transfers row to satisfy trades.transfer_id's own foreign key)
// keeps every value in each scenario's own hand computed answer exact and independent of
// that traffic, the same way scenarios below still prove the real HTTP route, its cache and
// its rate limit honestly.

async function sandboxKey(): Promise<string> {
  const id = newId("key");
  const hash = createHash("sha256").update(randomBytes(32)).digest();
  await testPool().query(
    "insert into api_keys (id, secret_hash, prefix, last4, mode, scopes) values ($1, $2, 'pl_test', 'abcd', 'test', '{exchange:trade}')",
    [id, hash]);
  return id;
}

interface OrderSpec {
  keyId: string; market: string; side: "buy" | "sell"; price: string; quantity: string;
  filledQuantity?: string; status?: string;
}

/** A minimal, valid orders row, inserted directly rather than through place_order: enough
 * for the book's own read (src/db/market-data.ts's getBookLevels only reads price, side,
 * status and the remaining quantity) and to satisfy trades.buy_order_id / sell_order_id's
 * own foreign key for insertTrade below. hold_id stays null: nothing here ever touches the
 * ledger, so there is no hold for it to name. */
async function insertOrder(spec: OrderSpec): Promise<string> {
  const id = newId("ord");
  await testPool().query(
    `insert into orders (id, key_id, market, client_order_id, side, type, time_in_force, post_only,
       price, quantity, quote_amount, filled_quantity, filled_quote, status, hold_id, accepted_seq, reject_reason, created_at, updated_at)
     values ($1,$2,$3,null,$4,'limit','GTC',false,$5,$6,null,$7,0,$8,null,null,null,now(),now())`,
    [id, spec.keyId, spec.market, spec.side, spec.price, spec.quantity, spec.filledQuantity ?? "0", spec.status ?? "open"]);
  return id;
}

// Comfortably clear of any seq a real, concurrently running place_order call assigns during
// this run (a handful of orders per scenario across the whole suite, never near a million),
// so this file's own synthetic trades never collide with a real one sharing the same
// market. trades.seq itself carries no uniqueness constraint of its own (unlike
// market_events, which is never touched here), so a private, ever increasing counter is
// enough to keep this file's own rows in the right relative order.
let syntheticSeq = 900_000_000;

/** A trade row with an exact, hand chosen price, quantity, notional and created_at,
 * inserted directly rather than produced by a real fill. buyer_fee and seller_fee are
 * irrelevant to every function under test here (none of book, trades, ticker or candles
 * reads either), so both are zero rather than a computed figure. */
async function insertTrade(market: string, price: string, quantity: string, notional: string, at: Date): Promise<{ id: string; seq: string }> {
  const buyer = await sandboxKey();
  const seller = await sandboxKey();
  const buyOrderId = await insertOrder({ keyId: buyer, market, side: "buy", price, quantity, filledQuantity: quantity, status: "filled" });
  const sellOrderId = await insertOrder({ keyId: seller, market, side: "sell", price, quantity, filledQuantity: quantity, status: "filled" });
  const transferId = newId("tr");
  await testPool().query("insert into transfers (id, ledger_id) values ($1, 'ldg_exchange')", [transferId]);
  // newId's own IdPrefix union has no "trade" entry (only src/db/exchange.ts's SQL side ever
  // mints one, through Postgres's own new_id function), so a trade id is built the same way,
  // by hand, rather than widening that union just for this file's own synthetic rows.
  const id = `trade_${randomBytes(16).toString("hex")}`;
  const seq = String(++syntheticSeq);
  await testPool().query(
    `insert into trades (id, market, seq, buy_order_id, sell_order_id, price, quantity, notional, buyer_fee, seller_fee, transfer_id, created_at)
     values ($1,$2,$3::bigint,$4,$5,$6,$7,$8,0,0,$9,$10)`,
    [id, market, seq, buyOrderId, sellOrderId, price, quantity, notional, transferId, at]);
  return { id, seq };
}

/** Wraps a real pool's connect so every query issued on a connection it hands out is
 * counted, proving a cache hit runs no SQL at all rather than merely a fast one. Only
 * connect is stubbed: this file's own cached route (the markets list) never calls
 * deps.pool.query directly, only withTx, so nothing else needs wrapping. */
function countingPool(real: Pool): { pool: Pool; count: () => number } {
  let calls = 0;
  const stub = {
    connect: async () => {
      const client = await real.connect();
      const originalQuery = client.query.bind(client);
      client.query = ((...args: Parameters<typeof originalQuery>) => {
        calls++;
        return originalQuery(...args);
      }) as typeof client.query;
      return client;
    },
  };
  return { pool: stub as unknown as Pool, count: () => calls };
}

describe("public market data", () => {
  it("aggregates the book by price and reports the market's current seq", async () => {
    const { app } = await makeTestApp();
    const buyer = await sandboxKey();
    const seller = await sandboxKey();
    // Distinctive, tick aligned prices (ETH-USDT: tick 10,000, 0.01 USDT) nothing else in
    // this suite prices at, so each level's aggregate below is exactly these orders,
    // regardless of anything else resting on the shared book.
    const bidPrice = "345670000"; // 345.67 USDT
    const askPrice = "345680000"; // 345.68 USDT
    await insertOrder({ keyId: buyer, market: "ETH-USDT", side: "buy", price: bidPrice, quantity: "2000000" });
    await insertOrder({ keyId: buyer, market: "ETH-USDT", side: "buy", price: bidPrice, quantity: "3000000" });
    await insertOrder({ keyId: seller, market: "ETH-USDT", side: "sell", price: askPrice, quantity: "4000000" });

    const res = await request(app).get("/v1/exchange/markets/ETH-USDT/book?depth=100");
    expect(res.status).toBe(200);
    expect(res.body.market).toBe("ETH-USDT");
    expect(res.body.seq).toMatch(/^\d+$/);
    const bidLevel = (res.body.bids as Array<{ price: string }>).find((l) => l.price === bidPrice);
    expect(bidLevel).toEqual({ price: bidPrice, quantity: "5000000", orders: "2" });
    const askLevel = (res.body.asks as Array<{ price: string }>).find((l) => l.price === askPrice);
    expect(askLevel).toEqual({ price: askPrice, quantity: "4000000", orders: "1" });
  });

  it("404s an unknown market symbol", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/v1/exchange/markets/ZZZ-ZZZ/book");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
  });

  it("rejects a depth of 0 or 101 as validation_failed", async () => {
    const { app } = await makeTestApp();
    const low = await request(app).get("/v1/exchange/markets/ETH-USDT/book?depth=0");
    expect(low.status).toBe(422);
    expect(low.body.code).toBe("validation_failed");
    const high = await request(app).get("/v1/exchange/markets/ETH-USDT/book?depth=101");
    expect(high.status).toBe(422);
    expect(high.body.code).toBe("validation_failed");
  });

  it("lists trades newest first", async () => {
    const { app } = await makeTestApp();
    const first = await insertTrade("ETH-USDT", "888880000", "2000000", "17777600", new Date());
    const second = await insertTrade("ETH-USDT", "888880000", "1000000", "8888800", new Date());

    const res = await request(app).get("/v1/exchange/markets/ETH-USDT/trades?limit=200");
    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((t) => t.id);
    const firstIndex = ids.indexOf(first.id);
    const secondIndex = ids.indexOf(second.id);
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThanOrEqual(0);
    // Newest first: the trade inserted second (the higher seq) sorts earlier.
    expect(secondIndex).toBeLessThan(firstIndex);
  });

  it("computes ticker fields by hand from two trades, and answers nulls for a window with none", async () => {
    const asOf = new Date("2021-03-01T12:00:00.000Z");
    const t1 = new Date("2021-03-01T11:00:00.000Z");
    const t2 = new Date("2021-03-01T11:30:00.000Z");
    // notional = price * quantity / 10^8. trade1: 200,000,000 * 3,000,000 / 1e8 = 6,000,000.
    // trade2: 210,000,000 * 3,000,000 / 1e8 = 6,300,000.
    await insertTrade("ETH-USDT", "200000000", "3000000", "6000000", t1);
    await insertTrade("ETH-USDT", "210000000", "3000000", "6300000", t2);

    const ticker = await withTx(testPool(), (c) => M.getTicker(c, "ETH-USDT", asOf));
    expect(ticker).toEqual({
      last: "210000000", high_24h: "210000000", low_24h: "200000000",
      base_volume_24h: "6000000", quote_volume_24h: "12300000",
    });

    const empty = await withTx(testPool(), (c) => M.getTicker(c, "ETH-USDT", new Date("2000-01-01T00:00:00.000Z")));
    expect(empty).toEqual({ last: null, high_24h: null, low_24h: null, base_volume_24h: null, quote_volume_24h: null });
  });

  it("aggregates a 1 minute candle by hand from three trades in the same bucket", async () => {
    const t1 = new Date("2019-09-10T08:00:05.000Z");
    const t2 = new Date("2019-09-10T08:00:20.000Z");
    const t3 = new Date("2019-09-10T08:00:45.000Z");
    // notional = price * quantity / 10^8.
    await insertTrade("ETH-USDT", "1000000000", "1000000", "10000000", t1); // open: 1,000.00 USDT
    await insertTrade("ETH-USDT", "1020000000", "3000000", "30600000", t2); // high: 1,020.00 USDT
    await insertTrade("ETH-USDT", "990000000", "2000000", "19800000", t3); // low and close: 990.00 USDT

    const candles = await withTx(testPool(), (c) => M.getCandles(c, "ETH-USDT", "1m", 500));
    const bucket = candles.find((row) => row.t === "2019-09-10T08:00:00.000Z");
    // volume = 1,000,000 + 3,000,000 + 2,000,000.
    expect(bucket).toEqual({
      t: "2019-09-10T08:00:00.000Z",
      open: "1000000000", high: "1020000000", low: "990000000", close: "990000000",
      volume: "6000000",
    });
  });

  it("serves a second read within two seconds from cache, running no further SQL", async () => {
    const wrapped = countingPool(testPool());
    const { app } = await makeTestApp({ pool: wrapped.pool });

    const first = await request(app).get("/v1/exchange/markets");
    expect(first.status).toBe(200);
    const afterFirst = wrapped.count();
    expect(afterFirst).toBeGreaterThan(0);

    const second = await request(app).get("/v1/exchange/markets");
    expect(second.status).toBe(200);
    expect(wrapped.count()).toBe(afterFirst);
    expect(second.body).toEqual(first.body);
  });

  it("treats a cache read or write failure as a miss, not a 500", async () => {
    const brokenCache: Cache = {
      get: async () => { throw new Error("redis unreachable"); },
      set: async () => { throw new Error("redis unreachable"); },
    };
    const { app } = await makeTestApp({ cache: brokenCache });
    const res = await request(app).get("/v1/exchange/markets");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("limits the public proof to two calls a minute per IP, then 429", async () => {
    const { app } = await makeTestApp();
    const ip = "198.51.100.7";
    const first = await request(app).get("/v1/exchange/verify").set("X-Forwarded-For", ip);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, chain_ok: true, sequence_ok: true, replay_matches: true });
    const second = await request(app).get("/v1/exchange/verify").set("X-Forwarded-For", ip);
    expect(second.status).toBe(200);
    const third = await request(app).get("/v1/exchange/verify").set("X-Forwarded-For", ip);
    expect(third.status).toBe(429);
    expect(third.body.code).toBe("rate_limited");
  });
});
