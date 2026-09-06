import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import { SWEEP_DELETE_CAP } from "../../src/db/events.js";
import { withTx } from "../../src/db/pool.js";
import { newId } from "../../src/domain/ids.js";
import * as L from "../../src/db/ledger.js";
import { EXCHANGE_LEDGER_ID } from "../../src/db/exchange.js";

describe("the sweep", () => {
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
});
