import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { testPool } from "../helpers/db.js";
import { makeTestApp } from "../helpers/app.js";
import { resetExchangeBooks } from "../helpers/exchange.js";
import { withTx } from "../../src/db/pool.js";
import { newId } from "../../src/domain/ids.js";
import { placeOrder, cancelOrder, exchangeFaucet, MARKETS, type PlaceOrderInput } from "../../src/db/exchange.js";
import { streamOptions, STREAM_DEFAULTS } from "../../src/routes/exchange-stream.js";

// The public market event stream, task 8, spec 10.7 shipped as SSE rather than a WebSocket
// upgrade. Every replay and tail scenario below places real orders through the same
// place_order the matching engine uses (src/db/exchange.ts), proving the stream against the
// exact rows place_order itself commits; the one scenario proving the derived fill shape
// (the last one below) writes its own market_events row directly instead, for reasons
// documented on appendFillEvent below.
//
// Every synthetic order here is a GTC limit sell resting at a price far above anything any
// other test file, or the house ladder, would ever realistically bid (tens of thousands of
// dollars a bitcoin is a real price; half a million is not), so it can never cross a resting
// bid left behind by a different test file sharing this same database. A sell never crosses
// another sell, so distinct scenarios below never interfere with one another either, however
// close their hand chosen prices land.

async function sandboxKey(): Promise<string> {
  const id = newId("key");
  const hash = createHash("sha256").update(randomBytes(32)).digest();
  await testPool().query(
    "insert into api_keys (id, secret_hash, prefix, last4, mode, scopes) values ($1, $2, 'pl_test', 'abcd', 'test', '{exchange:trade}')",
    [id, hash]);
  return id;
}

async function fundedKey(): Promise<string> {
  const id = await sandboxKey();
  await withTx(testPool(), (c) => exchangeFaucet(c, id));
  return id;
}

function sellOrder(over: Partial<PlaceOrderInput> & { keyId: string; price: string; quantity: string }): PlaceOrderInput {
  return {
    market: "BTC-USDT", clientOrderId: null, side: "sell", type: "limit", timeInForce: "GTC", postOnly: false,
    quoteAmount: null, ...over,
  };
}

/** Every resting sell this file places is GTC and never fills on its own, so it would
 * otherwise sit on the book for the rest of the suite. The one scenario that needs an actual
 * fill (the last one below) crosses whichever resting ask is cheapest, price time priority,
 * not necessarily the one it just placed; cancelling each scenario's own resting orders once
 * its own assertions are done is what keeps a later scenario's book empty below its own
 * chosen price. */
async function cancelResting(keyId: string, orderId: string): Promise<void> {
  await withTx(testPool(), (c) => cancelOrder(c, keyId, orderId));
}

/**
 * The scenario proving the derived shapes for a fill (the last one below) does not place a
 * real crossing order at all: a real cross always matches whatever resting order is cheapest,
 * price time priority, and this shared database can hold a resting house ladder
 * (tests/integration/house.test.ts leaves BTC-USDT quoted around 80,000 USDT, and it never
 * expires or gets cancelled on its own) or another file's own resting order at any price, so
 * a hand chosen crossing price has no way to guarantee which order it actually reaches.
 * append_market_event (db/migrations/0013_place_order.sql) is the same function place_order
 * itself calls to write a market_events row; calling it directly writes one order.filled row
 * with a hand built payload in the exact shape place_order writes one, gaplessly sequenced by
 * the market's own counter, without ever touching the orders or holds tables at all. This
 * proves the route's own derivation of the book and trades shapes from that row, the thing
 * this scenario actually exists to cover, with no dependency on what any other file or the
 * house left resting on the book.
 */
async function appendFillEvent(market: string, payload: Record<string, string>): Promise<void> {
  await testPool().query("select append_market_event($1, 'order.filled', $2::jsonb, now())", [market, JSON.stringify(payload)]);
}

/**
 * A market this exchange's own MARKETS list does not know about until this call, for the
 * one scenario below that needs a long backlog with no risk of another test file's own
 * orders landing in the middle of it (every other scenario in this file shares BTC-USDT
 * with the rest of the exchange test suite). market_events.market references
 * markets(symbol) (db/migrations/0011_exchange.sql), so a row has to exist in markets
 * first; it copies BTC-USDT's own tick_size and lot_size, already valid against
 * enforce_market_tick_lot since that trigger accepted the very same pair for the real
 * BTC-USDT row. MARKETS itself (src/db/exchange.ts) is a plain array, not frozen the way
 * STREAM_DEFAULTS is, so pushing this symbol onto it is what lets the stream route's own
 * isMarketSymbol check accept it for the lifetime of this one test file's process;
 * releasePrivateMarket below takes it back off and removes the row, so no later test or
 * file ever sees it.
 */
async function registerPrivateMarket(symbol: string): Promise<void> {
  await testPool().query(
    `insert into markets (symbol, base, quote, tick_size, lot_size, min_notional, maker_fee_bps, taker_fee_bps, status, next_seq)
     values ($1, 'BTC', 'USDT', 10000, 100000, 5000000, 10, 10, 'open', 1)`,
    [symbol]);
  (MARKETS as unknown as string[]).push(symbol);
}

async function releasePrivateMarket(symbol: string): Promise<void> {
  const idx = (MARKETS as unknown as string[]).indexOf(symbol);
  if (idx !== -1) (MARKETS as unknown as string[]).splice(idx, 1);
  await testPool().query("delete from market_events where market = $1", [symbol]);
  await testPool().query("delete from markets where symbol = $1", [symbol]);
}

async function currentSeq(market: string): Promise<bigint> {
  const { rows } = await testPool().query<{ seq: string }>(
    "select coalesce(max(seq), 0)::text as seq from market_events where market = $1", [market]);
  return BigInt(rows[0]!.seq);
}

interface SseFrame { event: string; id?: string; data?: string }

function parseFrame(raw: string): SseFrame {
  const frame: SseFrame = { event: "message" };
  for (const line of raw.split("\n")) {
    if (line.startsWith("id: ")) frame.id = line.slice(4);
    else if (line.startsWith("event: ")) frame.event = line.slice(7);
    else if (line.startsWith("data: ")) frame.data = line.slice(6);
    else if (line.startsWith(":")) frame.event = "heartbeat";
  }
  return frame;
}

function connectSse(port: number, qs: string): Promise<{ req: http.ClientRequest; res: http.IncomingMessage; frames: SseFrame[] }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/v1/exchange/stream?${qs}` }, (res) => {
      const frames: SseFrame[] = [];
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          frames.push(parseFrame(buffer.slice(0, idx)));
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf("\n\n");
        }
      });
      resolve({ req, res, frames });
    });
    req.on("error", reject);
  });
}

function getJson(port: number, qs: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: `/v1/exchange/stream?${qs}` }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
    }).on("error", reject);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("GET /v1/exchange/stream", () => {
  let server: http.Server;
  let port: number;
  const openReqs: http.ClientRequest[] = [];

  beforeAll(async () => {
    await resetExchangeBooks();
    const { app } = await makeTestApp();
    server = app.listen(0);
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  afterEach(async () => {
    for (const req of openReqs.splice(0)) req.destroy();
    Object.assign(streamOptions, STREAM_DEFAULTS);
    // Lets the server side process every socket teardown (and decrement the concurrent
    // stream counter) before the next test starts counting from a clean slate.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it("replays existing events in seq order, then a heartbeat comment", async () => {
    streamOptions.heartbeatIntervalMs = 200;
    const key = await fundedKey();
    const before = await currentSeq("BTC-USDT");
    const r1 = await placeOrder(testPool(), sellOrder({ keyId: key, price: "500000000000", quantity: "100000" }));
    const r2 = await placeOrder(testPool(), sellOrder({ keyId: key, price: "500010000000", quantity: "100000" }));
    const r3 = await placeOrder(testPool(), sellOrder({ keyId: key, price: "500020000000", quantity: "100000" }));

    const { req, frames } = await connectSse(port, `channels=book:BTC-USDT&since=${before}`);
    openReqs.push(req);

    await waitFor(() => frames.some((f) => f.event === "heartbeat"), 3000);
    const messages = frames.filter((f) => f.event === "message");
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.id)).toEqual([String(before + 1n), String(before + 2n), String(before + 3n)]);
    for (const m of messages) {
      const parsed = JSON.parse(m.data as string) as { channel: string; seq: string; data: { type: string; at: string } };
      expect(parsed.channel).toBe("book:BTC-USDT");
      expect(parsed.data.type).toBe("order.accepted");
      expect(typeof parsed.data.at).toBe("string");
      expect(new Date(parsed.data.at).toISOString()).toBe(parsed.data.at);
    }
    for (const r of [r1, r2, r3]) await cancelResting(key, r.order.id);
  });

  it("delivers a new order placed during the tail within two seconds", async () => {
    streamOptions.tailIntervalMs = 100;
    const key = await fundedKey();
    const before = await currentSeq("BTC-USDT");

    const { req, frames } = await connectSse(port, `channels=book:BTC-USDT&since=${before}`);
    openReqs.push(req);

    const r = await placeOrder(testPool(), sellOrder({ keyId: key, price: "500030000000", quantity: "100000" }));

    await waitFor(() => frames.some((f) => f.event === "message"), 2000);
    const messages = frames.filter((f) => f.event === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe(String(before + 1n));
    await cancelResting(key, r.order.id);
  });

  it("a reconnect with since equal to the last seq receives only newer events", async () => {
    streamOptions.tailIntervalMs = 100;
    const key = await fundedKey();
    const r1 = await placeOrder(testPool(), sellOrder({ keyId: key, price: "500040000000", quantity: "100000" }));
    const afterFirst = await currentSeq("BTC-USDT");

    const { req, frames } = await connectSse(port, `channels=book:BTC-USDT&since=${afterFirst}`);
    openReqs.push(req);

    const r2 = await placeOrder(testPool(), sellOrder({ keyId: key, price: "500050000000", quantity: "100000" }));

    await waitFor(() => frames.some((f) => f.event === "message"), 2000);
    // Give a real tail tick or two the chance to (wrongly) replay the earlier event too
    // before asserting the count is final.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const messages = frames.filter((f) => f.event === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe(String(afterFirst + 1n));
    await cancelResting(key, r1.order.id);
    await cancelResting(key, r2.order.id);
  });

  it("sends the reconnect event and ends the response at the overridden lifetime", async () => {
    streamOptions.lifetimeMs = 500;
    const before = await currentSeq("BTC-USDT");

    const { req, res, frames } = await connectSse(port, `channels=book:BTC-USDT&since=${before}`);
    openReqs.push(req);
    const ended = new Promise<void>((resolve) => res.on("end", resolve));

    await waitFor(() => frames.some((f) => f.event === "reconnect"), 2000);
    const reconnectFrame = frames.find((f) => f.event === "reconnect")!;
    expect(JSON.parse(reconnectFrame.data as string)).toEqual({ reason: "reconnect" });
    await ended;
  });

  it("answers 422 for an unknown channel or an unknown symbol, before any stream headers", async () => {
    const badFormat = await getJson(port, "channels=ticker:BTC-USDT&since=0");
    expect(badFormat.status).toBe(422);
    const badSymbol = await getJson(port, "channels=book:XRP-USDT&since=0");
    expect(badSymbol.status).toBe(422);
  });

  it("answers 429 for the eleventh concurrent stream from one address", async () => {
    const before = await currentSeq("BTC-USDT");
    for (let i = 0; i < 10; i++) {
      const { req } = await connectSse(port, `channels=book:BTC-USDT&since=${before}`);
      openReqs.push(req);
    }
    const eleventh = await getJson(port, `channels=book:BTC-USDT&since=${before}`);
    expect(eleventh.status).toBe(429);
  });

  it("a fill reaches both book and trades channels, without either order's identity", async () => {
    streamOptions.tailIntervalMs = 100;
    const before = await currentSeq("BTC-USDT");

    const { req, frames } = await connectSse(port, `channels=book:BTC-USDT,trades:BTC-USDT&since=${before}`);
    openReqs.push(req);

    await appendFillEvent("BTC-USDT", {
      buy_order_id: "ord_synthetic_buyer", sell_order_id: "ord_synthetic_seller",
      price: "8000000000", quantity: "100000", notional: "8000000",
    });

    await waitFor(() => frames.some((f) => {
      if (f.event !== "message") return false;
      const parsed = JSON.parse(f.data as string) as { channel: string };
      return parsed.channel === "trades:BTC-USDT";
    }), 2000);

    const messages = frames.filter((f) => f.event === "message")
      .map((f) => JSON.parse(f.data as string) as { channel: string; seq: string; data: Record<string, unknown> });
    const bookFill = messages.find((m) => m.channel === "book:BTC-USDT" && m.data.type === "order.filled");
    const trade = messages.find((m) => m.channel === "trades:BTC-USDT");

    expect(bookFill).toBeDefined();
    const { at: bookFillAt, ...bookFillRest } = bookFill!.data as Record<string, unknown>;
    expect(bookFillRest).toEqual({ type: "order.filled", price: "8000000000", quantity: "100000", notional: "8000000" });
    expect(typeof bookFillAt).toBe("string");
    expect(new Date(bookFillAt as string).toISOString()).toBe(bookFillAt);

    expect(trade).toBeDefined();
    const { at: tradeAt, ...tradeRest } = trade!.data as Record<string, unknown>;
    expect(tradeRest).toEqual({ price: "8000000000", quantity: "100000", notional: "8000000" });
    expect(typeof tradeAt).toBe("string");
    expect(new Date(tradeAt as string).toISOString()).toBe(tradeAt);
    expect(Object.keys(trade!.data)).not.toContain("buy_order_id");
    expect(Object.keys(trade!.data)).not.toContain("sell_order_id");
  });

  it("pages a long replay across multiple queries without skipping or repeating rows", async () => {
    const symbol = "ZZZ-PAGETEST";
    const rowCount = 1200;
    // Well past any real tail tick, so the only way every row can arrive inside this
    // test's own waitFor window is the initial replay looping through more than one page
    // on its own; a replay that sends only the first page and leaves the rest for a later
    // tail tick to trickle out would time out here rather than passing by accident.
    streamOptions.tailIntervalMs = 60_000;
    await registerPrivateMarket(symbol);
    try {
      // Written directly against market_events, gaplessly seq 1..rowCount, rather than
      // through place_order: this proves fetchEvents' own paging and pump()'s loop, the
      // thing this scenario exists to cover, with no dependency on the matching engine or
      // on anything else in this shared database. rowCount is well over
      // EVENTS_PAGE_LIMIT (500, src/routes/exchange-stream.ts), so the replay only
      // completes if the route re-queries at least twice, each time resuming from the
      // last seq it actually sent.
      await testPool().query(
        `insert into market_events (market, seq, type, payload)
         select $1, gs, 'order.accepted',
           jsonb_build_object('order_id', 'ord_page_' || gs::text, 'side', case when gs % 2 = 0 then 'buy' else 'sell' end, 'type', 'limit')
         from generate_series(1, $2::bigint) as gs`,
        [symbol, rowCount]);

      const { req, frames } = await connectSse(port, `channels=book:${symbol}&since=0`);
      openReqs.push(req);

      await waitFor(() => frames.filter((f) => f.event === "message").length >= rowCount, 10000);
      // Settles briefly before the count is asserted as final: the tail is parked at a
      // minute above, so nothing more should ever arrive once the replay itself is done.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const messages = frames.filter((f) => f.event === "message");
      expect(messages).toHaveLength(rowCount);
      expect(messages.map((m) => m.id)).toEqual(Array.from({ length: rowCount }, (_, i) => String(i + 1)));
      for (const m of messages) {
        const parsed = JSON.parse(m.data as string) as { data: { at: string } };
        expect(typeof parsed.data.at).toBe("string");
      }
    } finally {
      await releasePrivateMarket(symbol);
    }
  });
});
