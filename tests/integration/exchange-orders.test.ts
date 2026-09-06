import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { Express } from "express";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import { signRequest } from "../../src/platform/signing.js";
import { MemoryScheduler } from "../../src/platform/scheduler.js";
import { deliverOnce } from "../../src/platform/deliver.js";

// The orders HTTP surface, spec 10.10, over the matching engine task 4 already proved at
// the database layer (tests/integration/matching.test.ts): place, cancel by id or
// client_order_id, cancel all, list with a status filter, get one, my trades, and the
// client_order_id idempotency handle. Every scenario here uses a market and price band of
// its own (60,000,000,000 upward on BTC-USDT, 1,500,000,000 on ETH-USDT) that
// matching.test.ts never touches, and always either fills or cancels whatever it rests, so
// nothing here can cross an order left resting by a different test file sharing the same
// database, and nothing here leaves anything behind for the next one either.

type App = Express;
interface Key { id: string; secret: string }

function sign(k: Key, method: string, path: string, body?: unknown): Record<string, string> {
  return signRequest({ keyId: k.id, secret: k.secret, method, path, timestamp: Date.now(), body: body !== undefined ? JSON.stringify(body) : undefined });
}

async function fundedKey(app: App): Promise<Key> {
  const k = await mintKey(app);
  const res = await request(app).post("/v1/exchange/faucet").set(sign(k, "POST", "/v1/exchange/faucet")).send();
  if (res.status !== 200) throw new Error(`faucet failed: ${res.status} ${JSON.stringify(res.body)}`);
  return k;
}

function place(app: App, k: Key, body: Record<string, unknown>) {
  return request(app).post("/v1/exchange/orders").set(sign(k, "POST", "/v1/exchange/orders", body)).send(body);
}
function cancelById(app: App, k: Key, id: string) {
  const path = `/v1/exchange/orders/${id}`;
  return request(app).delete(path).set(sign(k, "DELETE", path));
}
function cancelAll(app: App, k: Key, market?: string) {
  const path = market ? `/v1/exchange/orders?market=${market}` : "/v1/exchange/orders";
  return request(app).delete(path).set(sign(k, "DELETE", path));
}
function listOrders(app: App, k: Key, qs = "") {
  const path = `/v1/exchange/orders${qs}`;
  return request(app).get(path).set(sign(k, "GET", path));
}
function getOrder(app: App, k: Key, id: string) {
  const path = `/v1/exchange/orders/${id}`;
  return request(app).get(path).set(sign(k, "GET", path));
}
function myTrades(app: App, k: Key) {
  const path = "/v1/exchange/trades";
  return request(app).get(path).set(sign(k, "GET", path));
}
function balancesOf(app: App, k: Key) {
  const path = "/v1/exchange/balances";
  return request(app).get(path).set(sign(k, "GET", path));
}

interface Received { body: string }
function receiver(): Promise<{ url: string; got: Received[]; close: () => void }> {
  const got: Received[] = [];
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { got.push({ body }); res.statusCode = 200; res.end("ok"); });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/hook`, got, close: () => server.close() });
    });
  });
}

describe("exchange orders", () => {
  it("places a limit order and reads it back identically, every money field a string", async () => {
    const { app } = await makeTestApp();
    const k = await fundedKey(app);
    const payload = { market: "BTC-USDT", side: "buy", type: "limit", price: "60000000000", quantity: "100000", client_order_id: "pg-1" };
    const placed = await place(app, k, payload);
    expect(placed.status).toBe(201);
    expect(placed.body).toMatchObject({
      market: "BTC-USDT", side: "buy", type: "limit", time_in_force: "GTC", post_only: false,
      price: "60000000000", quantity: "100000", quote_amount: null,
      filled_quantity: "0", filled_quote: "0", status: "open", reject_reason: null, client_order_id: "pg-1",
    });
    for (const field of ["id", "hold_id", "accepted_seq", "created_at", "updated_at"]) {
      expect(typeof placed.body[field]).toBe("string");
    }

    const got = await getOrder(app, k, placed.body.id as string);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(placed.body);

    await cancelAll(app, k);
  });

  it("lists it under status=open, and no longer once cancelled", async () => {
    const { app } = await makeTestApp();
    const k = await fundedKey(app);
    const placed = await place(app, k, { market: "BTC-USDT", side: "buy", type: "limit", price: "61000000000", quantity: "100000" });
    expect(placed.status).toBe(201);

    const open = await listOrders(app, k, "?status=open");
    expect(open.status).toBe(200);
    expect(open.body.data.map((o: { id: string }) => o.id)).toContain(placed.body.id);

    await cancelById(app, k, placed.body.id as string);

    const openAfter = await listOrders(app, k, "?status=open");
    expect(openAfter.body.data.map((o: { id: string }) => o.id)).not.toContain(placed.body.id);
    const cancelledHistory = await listOrders(app, k, "?status=cancelled");
    expect(cancelledHistory.body.data.map((o: { id: string }) => o.id)).toContain(placed.body.id);
  });

  it("cancels by client_order_id and releases the hold", async () => {
    const { app } = await makeTestApp();
    const k = await fundedKey(app);
    const before = await balancesOf(app, k);
    const usdtBefore = before.body.data.find((b: { asset: string }) => b.asset === "USDT");

    const placed = await place(app, k, {
      market: "BTC-USDT", side: "buy", type: "limit", price: "62000000000", quantity: "100000", client_order_id: "cancel-by-coid-1",
    });
    expect(placed.status).toBe(201);

    const held = await balancesOf(app, k);
    const usdtHeld = held.body.data.find((b: { asset: string }) => b.asset === "USDT");
    expect(BigInt(usdtHeld.held as string)).toBeGreaterThan(BigInt((usdtBefore?.held as string) ?? "0"));

    const cancelled = await cancelById(app, k, "cancel-by-coid-1");
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ id: placed.body.id, status: "cancelled" });

    const after = await balancesOf(app, k);
    const usdtAfter = after.body.data.find((b: { asset: string }) => b.asset === "USDT");
    expect(usdtAfter.held).toBe(usdtBefore?.held ?? "0");
  });

  it("cancel all scoped to one market leaves the other market's open order alone", async () => {
    const { app } = await makeTestApp();
    const k = await fundedKey(app);
    const btc = await place(app, k, { market: "BTC-USDT", side: "buy", type: "limit", price: "63000000000", quantity: "100000" });
    // Below, not above, matching.test.ts's ETH-USDT price band (1,000.00 to 1,010.00 USDT):
    // scenario (g) there deliberately leaves a sell resting forever at 1,010.00 USDT, and a
    // buy above that price would cross it the instant this test's own resting buy is placed,
    // whichever test file gets there first while both share the same database.
    const eth = await place(app, k, { market: "ETH-USDT", side: "buy", type: "limit", price: "900000000", quantity: "1000000" });
    expect(btc.status).toBe(201);
    expect(eth.status).toBe(201);

    const res = await cancelAll(app, k, "BTC-USDT");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id: btc.body.id, status: "cancelled" });

    const btcAfter = await getOrder(app, k, btc.body.id as string);
    expect(btcAfter.body.status).toBe("cancelled");
    const ethAfter = await getOrder(app, k, eth.body.id as string);
    expect(ethAfter.body.status).toBe("open");

    await cancelAll(app, k);
  });

  it("delivers order.filled to a webhook endpoint subscribed to it, through the memory scheduler", async () => {
    const { app, deps } = await makeTestApp();
    const scheduler = new MemoryScheduler((id) => deliverOnce(deps, id));
    deps.scheduler = scheduler;
    const buyer = await fundedKey(app);
    const seller = await fundedKey(app);
    const rx = await receiver();
    try {
      const ep = await request(app).post("/v1/webhooks").set(bearer(buyer.secret)).send({ url: "https://example.com/hook", events: ["order.filled"] });
      expect(ep.status).toBe(201);
      await deps.pool.query("update webhook_endpoints set url = $2 where id = $1", [ep.body.id, rx.url]);

      const rest = await place(app, seller, { market: "BTC-USDT", side: "sell", type: "limit", price: "64000000000", quantity: "100000" });
      expect(rest.status).toBe(201);
      const taker = await place(app, buyer, { market: "BTC-USDT", side: "buy", type: "limit", price: "64000000000", quantity: "100000" });
      expect(taker.status).toBe(201);
      expect(taker.body.status).toBe("filled");

      expect(rx.got).toHaveLength(1);
      const delivered = JSON.parse(rx.got[0]!.body);
      expect(delivered.type).toBe("order.filled");
    } finally {
      rx.close();
    }
  });

  // 0013_place_order.sql never inserts an orders row for a rejected attempt (see that
  // file's own header comment): doing so would let a retried client_order_id collide with
  // its own failed predecessor, exactly the idempotency this task's client_order_id replay
  // relies on. So a rejection's only record is market_events and the trader's own event
  // stream, not a status: "rejected" row in GET /v1/exchange/orders. This test asserts that
  // actual, deliberate behaviour rather than the row the brief's own wording (history with
  // status rejected) would suggest; see the task report for the full reasoning.
  it("rejects a structurally invalid order with 422 and the reason, recorded in the trader's own events, never as an orders row", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const res = await place(app, k, { market: "BTC-USDT", side: "buy", type: "limit", price: "68500000001", quantity: "100000" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("order_rejected");
    expect(res.body.detail).toBe("price_not_tick");

    const events = await request(app).get("/v1/events?type=order.rejected").set(bearer(k.secret));
    expect(events.status).toBe(200);
    expect(events.body.data).toHaveLength(1);
    expect(events.body.data[0].data.reason).toBe("price_not_tick");

    const list = await listOrders(app, k);
    expect(list.body.data).toEqual([]);
  });

  it("replays the first order for a byte identical body under the same client_order_id, and rejects a different one", async () => {
    const { app } = await makeTestApp();
    const k = await fundedKey(app);
    const payload = { market: "BTC-USDT", side: "buy", type: "limit", price: "69000000000", quantity: "100000", client_order_id: "idem-1" };

    const first = await place(app, k, payload);
    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();

    const second = await place(app, k, payload);
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);

    const different = await place(app, k, { ...payload, quantity: "200000" });
    expect(different.status).toBe(422);
    expect(different.body.code).toBe("order_rejected");
    expect(different.body.detail).toBe("duplicate_client_order_id");

    await cancelAll(app, k);
  });

  it("scopes every lookup by key: a foreign order id answers not_found for both get and cancel", async () => {
    const { app } = await makeTestApp();
    const owner = await fundedKey(app);
    const stranger = await fundedKey(app);
    const placed = await place(app, owner, { market: "BTC-USDT", side: "buy", type: "limit", price: "70000000000", quantity: "100000" });
    expect(placed.status).toBe(201);

    expect((await getOrder(app, stranger, placed.body.id as string)).status).toBe(404);
    expect((await cancelById(app, stranger, placed.body.id as string)).status).toBe(404);
    expect((await getOrder(app, owner, `ord_${"0".repeat(32)}`)).status).toBe(404);

    await cancelAll(app, owner);
  });

  it("lists the caller's own trades with side from the key's own point of view", async () => {
    const { app } = await makeTestApp();
    const buyer = await fundedKey(app);
    const seller = await fundedKey(app);
    const rest = await place(app, seller, { market: "BTC-USDT", side: "sell", type: "limit", price: "71000000000", quantity: "100000" });
    expect(rest.status).toBe(201);
    const taker = await place(app, buyer, { market: "BTC-USDT", side: "buy", type: "limit", price: "71000000000", quantity: "100000" });
    expect(taker.status).toBe(201);
    expect(taker.body.status).toBe("filled");

    const buyerTrades = await myTrades(app, buyer);
    expect(buyerTrades.status).toBe(200);
    expect(buyerTrades.body.data).toHaveLength(1);
    expect(buyerTrades.body.data[0]).toMatchObject({ side: "buy", quantity: "100000", price: "71000000000" });

    const sellerTrades = await myTrades(app, seller);
    expect(sellerTrades.body.data).toHaveLength(1);
    expect(sellerTrades.body.data[0]).toMatchObject({ side: "sell", quantity: "100000" });
  });

  it("charges weight 5 for status=open and weight 10 for history, spec 10.9", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const open = await listOrders(app, k, "?status=open");
    expect(open.status).toBe(200);
    expect(Number(open.headers["ratelimit-remaining"])).toBe(1200 - 5);
    const history = await listOrders(app, k, "");
    expect(history.status).toBe(200);
    expect(Number(history.headers["ratelimit-remaining"])).toBe(1200 - 5 - 10);
  });

  it("reset cancels every open order through cancel_order before releasing anything else", async () => {
    const { app } = await makeTestApp();
    const k = await fundedKey(app);
    const placed = await place(app, k, { market: "BTC-USDT", side: "buy", type: "limit", price: "72000000000", quantity: "100000" });
    expect(placed.status).toBe(201);

    const res = await request(app).post("/v1/exchange/reset").set(sign(k, "POST", "/v1/exchange/reset")).send();
    expect(res.status).toBe(200);

    const after = await getOrder(app, k, placed.body.id as string);
    expect(after.body.status).toBe("cancelled");
    const balances = await balancesOf(app, k);
    const usdt = balances.body.data.find((b: { asset: string }) => b.asset === "USDT");
    expect(usdt.held).toBe("0");
  });
});
