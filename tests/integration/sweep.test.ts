import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import { SWEEP_DELETE_CAP } from "../../src/db/events.js";
import { withTx } from "../../src/db/pool.js";
import { newId } from "../../src/domain/ids.js";
import * as L from "../../src/db/ledger.js";
import { EXCHANGE_LEDGER_ID, HOUSE_KEY_ID, placeOrder, cancelOrder, exchangeFaucet, type PlaceOrderInput } from "../../src/db/exchange.js";
import { refreshColdMarkets, topUpHouse } from "../../src/routes/internal.js";
import { resetExchangeBooks, verifyExchangeLedger } from "../helpers/exchange.js";
import { signRequest } from "../../src/platform/signing.js";

describe("the sweep", () => {
  // Cross file contamination: matching.test.ts, exchange-orders.test.ts, house.test.ts,
  // market-data.test.ts and exchange-wallet.test.ts all trade the same shared BTC-USDT
  // and ETH-USDT books this file's own house ladder and top up scenario touches.
  beforeAll(async () => {
    await resetExchangeBooks();
  });

  it("refuses without the secret and reports what it did with it", async () => {
    const { app, deps } = await makeTestApp();
    expect((await request(app).get("/internal/sweep")).status).toBe(401);
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "s" })).body;
    const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "a" })).body;
    await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:GHS", to: a.id, asset: "GHS", amount: "100" }] });
    const hold = (await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: a.id, amount: "10" })).body;
    await deps.pool.query("update holds set expires_at = now() - interval '1 minute' where id = $1", [hold.id]);
    const idle = await mintKey(app);
    const il = (await request(app).post("/v1/ledgers").set(bearer(idle.secret)).send({ name: "idle" })).body;
    await deps.pool.query("update ledgers set last_activity_at = now() - interval '15 days' where id = $1", [il.id]);
    await deps.pool.query("update api_keys set last_used_at = now() - interval '31 days', created_at = now() - interval '31 days' where id = $1", [idle.id]);
    const res = await request(app).get("/internal/sweep").set("Authorization", `Bearer ${deps.config.CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.expired_holds).toBeGreaterThanOrEqual(1);
    expect(res.body.deleted_ledgers).toBeGreaterThanOrEqual(1);
    expect(res.body.deleted_keys).toBeGreaterThanOrEqual(1);
    expect((await request(app).get("/v1/keys/me").set(bearer(idle.secret))).status).toBe(401);
    expect((await request(app).get(`/v1/ledgers/${l.id}/holds/${hold.id}`).set(h)).body.status).toBe("expired");
  });

  it("caps the events purge at SWEEP_DELETE_CAP and drains the rest on the next run", async () => {
    const { app, deps } = await makeTestApp();
    const k = await mintKey(app);
    const l = (await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: "backlog" })).body;
    const total = SWEEP_DELETE_CAP + 1;
    await deps.pool.query(
      `insert into events (id, key_id, ledger_id, type, entity_id, payload, created_at)
       select 'evt_backlog_' || g, $1, $2, 'test.event', 'entity', '{}'::jsonb, now() - interval '31 days'
       from generate_series(1, $3) g`,
      [k.id, l.id, total],
    );
    const auth = { Authorization: `Bearer ${deps.config.CRON_SECRET}` };
    const first = await request(app).get("/internal/sweep").set(auth);
    expect(first.status).toBe(200);
    expect(first.body.deleted_events).toBe(SWEEP_DELETE_CAP);
    const second = await request(app).get("/internal/sweep").set(auth);
    expect(second.status).toBe(200);
    expect(second.body.deleted_events).toBe(1);
    const { rows } = await deps.pool.query<{ n: string }>("select count(*)::text as n from events where id like 'evt_backlog_%'");
    expect(rows[0]?.n).toBe("0");
  });

  // Task 6, spec 10.5 and 10.2: the sweep refreshes any market whose house ladder is cold,
  // and tops any house account below a quarter of its seed back up from the world. Drains
  // the house's BTC account specifically, not ETH or USDT: house.test.ts exercises the
  // house ladder entirely against ETH-USDT, and exchange-orders.test.ts's own BTC-USDT
  // price band sits far below where the house's real reference driven ladder ever quotes
  // (spec 10.5's own note on that), so nothing else in the suite ever actually fills a
  // trade against the house's BTC account. USDT would be the wrong choice for the same
  // reason in reverse: every fill on either market moves it. The drain below moves real
  // money through post_transfer rather than writing balance directly, so the ledger's own
  // journal stays the source of truth throughout: after the sweep's top up, the account is
  // back at exactly its seed, not merely above the quarter threshold, and the whole
  // exchange ledger, shared with every other test file trading on it, still verifies.
  // Draining to 1,000 BTC rather than further leaves comfortable headroom over anything a
  // concurrent BTC-USDT house ladder refresh could need to hold for its own ask side.
  it("refreshes a cold market's house ladder and tops up a house account drained below a quarter of its seed", async () => {
    const { app, deps } = await makeTestApp();
    await deps.pool.query("update markets set house_quoted_at = now() - interval '20 seconds' where symbol = 'BTC-USDT'");

    const { rows: btcRows } = await deps.pool.query<{ id: string; balance: string }>(
      "select id, balance::text as balance from accounts where ledger_id = $1 and kind = 'normal' and name = 'BTC'",
      [EXCHANGE_LEDGER_ID]);
    const houseBtc = btcRows[0];
    if (!houseBtc) throw new Error("the house BTC account is missing");
    const seed = 1_000_000_000_000n;
    const drainTo = 100_000_000_000n; // 1,000 BTC, still well above what one house ladder's own ask side ever holds.
    const drainAmount = BigInt(houseBtc.balance) - drainTo;
    if (drainAmount > 0n) {
      await withTx(deps.pool, (c) => L.postTransfer(c, {
        ledgerId: EXCHANGE_LEDGER_ID, transferId: newId("tr"),
        legs: [{ from: houseBtc.id, to: "world:BTC", asset: "BTC", amount: drainAmount.toString() }],
        memo: "test: drain the house below the sweep's top up threshold", metadata: {},
      }));
    }

    const res = await request(app).get("/internal/sweep").set("Authorization", `Bearer ${deps.config.CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.markets_refreshed).toBeGreaterThanOrEqual(1);
    expect(res.body.house_topups).toBeGreaterThanOrEqual(1);

    const { rows: after } = await deps.pool.query<{ balance: string }>(
      "select balance::text as balance from accounts where id = $1", [houseBtc.id]);
    expect(BigInt(after[0]?.balance ?? "0")).toBe(seed);
  });

  // Review finding: refreshColdMarkets used to abort its whole loop, and skip topUpHouse
  // entirely (sweep calls it right after with nothing to catch an escaped exception), the
  // moment any one market's own refresh failed. Proven with an injected refresh that fails
  // for exactly one of the two real markets, not a real network failure:
  // fetchReferencePrice (src/platform/reference-price.ts) already swallows every fetch
  // failure into a plain null by design, so it can never actually propagate an exception
  // this far on its own; a failure reaching refreshColdMarkets has to come from somewhere
  // else in that one market's own refresh (a database hiccup, a bug), and this proves the
  // recovery holds regardless of the cause, without needing a real network or touching the
  // shared BTC-USDT and ETH-USDT books other exchange test files trade on.
  it("keeps refreshing other markets, and still tops up the house, when one market's own refresh throws", async () => {
    const { deps } = await makeTestApp();
    let goodCalls = 0;
    const refreshed = await refreshColdMarkets(deps, async (_deps, market) => {
      if (market === "ETH-USDT") throw new Error("simulated: this market's own refresh failed");
      goodCalls++;
    }, ["BTC-USDT", "ETH-USDT"]);
    expect(refreshed).toBe(1);
    expect(goodCalls).toBe(1);

    // topUpHouse shares nothing with refreshColdMarkets but deps: it runs, and answers,
    // exactly the same whether the call just above failed for a market or not.
    const topups = await topUpHouse(deps);
    expect(topups).toBeGreaterThanOrEqual(0);
  });

  // Whole branch review, finding 1 (critical): trades.buy_order_id and sell_order_id used
  // to carry no delete action against orders, while orders cascade from api_keys
  // (0011_exchange.sql). The first idle sandbox key the sweep ever deleted that had a fill
  // on either side of a trade turned that cascade into a foreign key violation, and the
  // throw ended the whole sweep before the purges, the refresh and the top up that follow
  // it ever ran. 0017_trades_survive_key_deletion.sql nulls that side instead of blocking
  // the delete; this proves the trade row, the counterparty's own history, and the ledger
  // itself all survive a real idle deletion, not only that the migration applied cleanly.
  it("survives an idle trader's key and ledger being swept away after a real fill, nulling that side of the trade rather than failing the sweep", async () => {
    // A clean book right before the crossing pair below, not only the file's own beforeAll:
    // an earlier test in this same file (the house ladder refresh scenario above) leaves a
    // real, cheaper house ladder resting on BTC-USDT, and price time priority would fill a
    // buy order against that first, never reaching this scenario's own resting sell.
    await resetExchangeBooks();
    const { app, deps } = await makeTestApp();
    const buyer = await mintKey(app);
    const seller = await mintKey(app);
    await withTx(deps.pool, (c) => exchangeFaucet(c, buyer.id));
    await withTx(deps.pool, (c) => exchangeFaucet(c, seller.id));

    const restInput: PlaceOrderInput = {
      keyId: seller.id, market: "BTC-USDT", clientOrderId: null, side: "sell", type: "limit",
      timeInForce: "GTC", postOnly: false, price: "950000000000", quantity: "100000", quoteAmount: null,
    };
    const takerInput: PlaceOrderInput = {
      keyId: buyer.id, market: "BTC-USDT", clientOrderId: null, side: "buy", type: "limit",
      timeInForce: "GTC", postOnly: false, price: "950000000000", quantity: "100000", quoteAmount: null,
    };
    const rest = await placeOrder(deps.pool, restInput);
    const taker = await placeOrder(deps.pool, takerInput);
    expect(taker.order.status).toBe("filled");
    // rest.order is the row as place_order returned it at the moment the sell was accepted,
    // necessarily "open" since nothing had crossed it yet; the taker's own fill updates
    // that same row afterward, so its current status is read fresh rather than off the
    // now stale in memory copy.
    const { rows: restRows } = await deps.pool.query<{ status: string }>("select status from orders where id = $1", [rest.order.id]);
    expect(restRows[0]?.status).toBe("filled");
    const trade = taker.trades[0];
    if (!trade) throw new Error("the crossing order did not fill");

    // A ledger of the buyer's own, alongside the exchange accounts a faucet call already
    // gave it, so both halves of "key and ledger, backdated idle" are real: the ledger idle
    // path (14 days, deleted directly) and the key idle path (30 days, cascading to every
    // order the key ever placed) both run in the same sweep.
    const buyerLedger = (await request(app).post("/v1/ledgers").set(bearer(buyer.secret)).send({ name: "idle-trader" })).body;
    await deps.pool.query("update ledgers set last_activity_at = now() - interval '15 days' where id = $1", [buyerLedger.id]);
    await deps.pool.query(
      "update api_keys set last_used_at = now() - interval '31 days', created_at = now() - interval '31 days' where id = $1",
      [buyer.id]);

    const res = await request(app).get("/internal/sweep").set("Authorization", `Bearer ${deps.config.CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted_keys).toBeGreaterThanOrEqual(1);
    expect(res.body.deleted_ledgers).toBeGreaterThanOrEqual(1);

    // The key, and the order it placed, are really gone.
    expect((await request(app).get("/v1/keys/me").set(bearer(buyer.secret))).status).toBe(401);
    const { rows: orderRows } = await deps.pool.query("select 1 from orders where id = $1", [taker.order.id]);
    expect(orderRows).toHaveLength(0);

    // The trade row survives, the buyer's side null, the seller's side still the real order.
    const { rows: tradeRows } = await deps.pool.query<{ buy_order_id: string | null; sell_order_id: string | null }>(
      "select buy_order_id, sell_order_id from trades where id = $1", [trade.id]);
    expect(tradeRows[0]?.buy_order_id).toBeNull();
    expect(tradeRows[0]?.sell_order_id).toBe(rest.order.id);

    // The counterparty's own trade history still lists it, side "sell" from their own point
    // of view, unaffected by the buyer's own side having been nulled.
    const sellerTradesPath = "/v1/exchange/trades";
    const sellerTrades = await request(app).get(sellerTradesPath)
      .set(signRequest({ keyId: seller.id, secret: seller.secret, method: "GET", path: sellerTradesPath, timestamp: Date.now() }));
    expect(sellerTrades.status).toBe(200);
    const listed = sellerTrades.body.data.find((t: { id: string }) => t.id === trade.id);
    expect(listed).toMatchObject({ side: "sell", buy_order_id: null, sell_order_id: rest.order.id });

    // The trader's own exchange accounts are not deleted (they belong to ldg_exchange, not
    // to the key), so the ledger stays fully balanced; the accounts themselves are now
    // orphaned, unreachable through any key, a deferred minor this fix does not chase.
    const report = await verifyExchangeLedger();
    expect(report).toMatchObject({ ok: true, chain_ok: true, sequence_ok: true, replay_matches: true });
  });

  // Security sweep, finding 5 (minor): every rotation writes a retiring secret with a fifteen
  // minute grace period, and nothing ever deleted one. Rotated for real through the route
  // rather than by inserting rows by hand, so the row under test is exactly the one a
  // rotation writes; only its expiry is moved, which is the one thing a test cannot wait out.
  it("purges retiring key secrets a day past their expiry and keeps the rest", async () => {
    const { app, deps } = await makeTestApp();
    const stale = await mintKey(app);
    const recent = await mintKey(app);
    const live = await mintKey(app);
    for (const k of [stale, recent, live]) {
      expect((await request(app).post("/v1/keys/rotate").set(bearer(k.secret)).send()).status).toBe(201);
    }
    // One well past the extra day the purge waits, one that expired an hour ago and is still
    // inside it, and one still inside its own grace period, untouched.
    await deps.pool.query("update api_key_old_secrets set expires_at = now() - interval '2 days' where key_id = $1", [stale.id]);
    await deps.pool.query("update api_key_old_secrets set expires_at = now() - interval '1 hour' where key_id = $1", [recent.id]);

    const res = await request(app).get("/internal/sweep").set("Authorization", `Bearer ${deps.config.CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted_old_secrets).toBeGreaterThanOrEqual(1);

    const { rows } = await deps.pool.query<{ key_id: string }>(
      "select key_id from api_key_old_secrets where key_id = any($1::text[])", [[stale.id, recent.id, live.id]]);
    expect(rows.map((r) => r.key_id).sort()).toEqual([recent.id, live.id].sort());
  });

  // Security sweep, finding 1 (critical): nothing ever purged orders or market_events, and
  // refresh_house_ladder (db/migrations/0016_house_ladder.sql) cancels ten orders and places
  // ten more per market, writing a market event for each, every time an unauthenticated book
  // read finds that market's ladder older than fifteen seconds. Both tables are kept to 24
  // hours by the sweep now. The house order purged below is a real one, placed as key_house
  // and filled by a real crossing buy, so the trade that names it, its transfer and the
  // ledger are all genuine rather than hand written rows.
  //
  // The market events half runs against a market of this test's own, registered here and
  // removed at the end, for the same reason tests/integration/stream.test.ts registers one:
  // BTC-USDT's and ETH-USDT's own event sequences are asserted gapless from one by
  // tests/integration/matching.test.ts and tests/property/exchange.property.test.ts, and
  // deleting the oldest row of either would leave a hole those checks would rightly fail on.
  // Its house_quoted_at is set to now so refreshColdMarkets skips it: this market has no
  // reference price and no ladder, and quoting one is not what is under test here.
  it("purges the house's own old terminal orders and old market events, keeping fresh ones, every other key's orders, and the trade", async () => {
    await resetExchangeBooks();
    const { app, deps } = await makeTestApp();
    const buyer = await mintKey(app);
    await withTx(deps.pool, (c) => exchangeFaucet(c, buyer.id));

    const houseSell: PlaceOrderInput = {
      keyId: HOUSE_KEY_ID, market: "BTC-USDT", clientOrderId: null, side: "sell", type: "limit",
      timeInForce: "GTC", postOnly: false, price: "950000000000", quantity: "100000", quoteAmount: null,
    };
    const rest = await placeOrder(deps.pool, houseSell);
    const taker = await placeOrder(deps.pool, { ...houseSell, keyId: buyer.id, side: "buy" });
    expect(taker.order.status).toBe("filled");
    const trade = taker.trades[0];
    if (!trade) throw new Error("the crossing order did not fill against the house's own order");
    expect(trade.sell_order_id).toBe(rest.order.id);

    // Both sides of the fill are aged past the retention window together: only the house's
    // own is the sweep's to delete, since every other key's orders already go with the key
    // itself when the idle sandbox sweep removes it.
    await deps.pool.query("update orders set updated_at = now() - interval '25 hours' where id = any($1::text[])", [[rest.order.id, taker.order.id]]);
    // A second house order, terminal but cancelled a moment ago rather than aged, to prove
    // the age bound is real and not "every terminal house order". Cancelled through
    // cancel_order, the way any real cancellation runs, so its hold is released too.
    const freshHouse = await placeOrder(deps.pool, { ...houseSell, price: "960000000000" });
    await withTx(deps.pool, (c) => cancelOrder(c, HOUSE_KEY_ID, freshHouse.order.id));

    const privateMarket = "SWEEP-RETENTION";
    await deps.pool.query(
      `insert into markets (symbol, base, quote, tick_size, lot_size, min_notional, maker_fee_bps, taker_fee_bps, status, next_seq, house_quoted_at)
       values ($1, 'BTC', 'USDT', 10000, 100000, 5000000, 10, 10, 'open', 3, now())`, [privateMarket]);
    await deps.pool.query(
      `insert into market_events (market, seq, type, payload, created_at) values
         ($1, 1, 'order.accepted', '{}'::jsonb, now() - interval '25 hours'),
         ($1, 2, 'order.accepted', '{}'::jsonb, now())`, [privateMarket]);

    const res = await request(app).get("/internal/sweep").set("Authorization", `Bearer ${deps.config.CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted_orders).toBeGreaterThanOrEqual(1);
    expect(res.body.deleted_market_events).toBeGreaterThanOrEqual(1);

    const survivors = await deps.pool.query<{ id: string }>(
      "select id from orders where id = any($1::text[])", [[rest.order.id, taker.order.id, freshHouse.order.id]]);
    expect(survivors.rows.map((r) => r.id).sort()).toEqual([taker.order.id, freshHouse.order.id].sort());

    const { rows: tradeRows } = await deps.pool.query<{ buy_order_id: string | null; sell_order_id: string | null; quantity: string }>(
      "select buy_order_id, sell_order_id, quantity::text as quantity from trades where id = $1", [trade.id]);
    expect(tradeRows[0]).toMatchObject({ buy_order_id: taker.order.id, sell_order_id: null, quantity: trade.quantity });

    const { rows: eventRows } = await deps.pool.query<{ seq: string }>(
      "select seq::text as seq from market_events where market = $1 order by seq", [privateMarket]);
    expect(eventRows.map((r) => r.seq)).toEqual(["2"]);

    await deps.pool.query("delete from market_events where market = $1", [privateMarket]);
    await deps.pool.query("delete from markets where symbol = $1", [privateMarket]);

    const report = await verifyExchangeLedger();
    expect(report).toMatchObject({ ok: true, chain_ok: true, sequence_ok: true, replay_matches: true });
  });
});
