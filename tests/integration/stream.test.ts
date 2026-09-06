import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { testPool } from "../helpers/db.js";
import { makeTestApp } from "../helpers/app.js";
import { resetExchangeBooks } from "../helpers/exchange.js";
import { withTx } from "../../src/db/pool.js";
import { newId } from "../../src/domain/ids.js";
import { placeOrder, cancelOrder, exchangeFaucet, type PlaceOrderInput } from "../../src/db/exchange.js";
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
      const parsed = JSON.parse(m.data as string) as { channel: string; seq: string; data: { type: string } };
      expect(parsed.channel).toBe("book:BTC-USDT");
      expect(parsed.data.type).toBe("order.accepted");
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
    expect(bookFill!.data).toEqual({ type: "order.filled", price: "8000000000", quantity: "100000", notional: "8000000" });
    expect(trade).toBeDefined();
    expect(trade!.data).toEqual({ price: "8000000000", quantity: "100000", notional: "8000000" });
    expect(Object.keys(trade!.data)).not.toContain("buy_order_id");
    expect(Object.keys(trade!.data)).not.toContain("sell_order_id");
  });
});
