import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import type { Cache } from "../../src/platform/cache.js";

describe("verify", () => {
  it("passes on an honest ledger, then fails naming the tampered sequence", async () => {
    const { app, deps } = await makeTestApp();
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "v" })).body;
    const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "USDT", name: "a" })).body;
    const b = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "USDT", name: "b" })).body;
    await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:USDT", to: a.id, asset: "USDT", amount: "1000000" }] });
    for (let i = 0; i < 5; i++) await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: a.id, to: b.id, asset: "USDT", amount: "1000" }] });
    const hold = (await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: a.id, amount: "500" })).body;
    await request(app).post(`/v1/ledgers/${l.id}/holds/${hold.id}/capture`).set(h).send({ to: b.id, amount: "200", release_remainder: true });
    const good = await request(app).get(`/v1/ledgers/${l.id}/verify`).set(h);
    expect(good.status).toBe(200);
    // entries_checked is 10: one funding transfer, five transfers, one hold created, one capture
    // transfer, one hold released (the capture drew 200 of 500, so the hold stayed open and
    // release_remainder released the other 300), and one hold captured closing it out.
    expect(good.body).toMatchObject({ ok: true, chain_ok: true, sequence_ok: true, replay_matches: true, cached: false, entries_checked: 10 });
    expect(good.body.assets).toEqual([{ asset: "USDT", sum: "0" }]);
    expect((await request(app).get(`/v1/ledgers/${l.id}/verify`).set(h)).body.cached).toBe(true);
    // Tamper with history: edit an amount inside entry 3 without touching its hash.
    await deps.pool.query("update journal set payload = jsonb_set(payload, '{transfer,legs,0,amount}', '\"999\"') where ledger_id = $1 and seq = 3", [l.id]);
    await deps.pool.query("update ledgers set next_seq = next_seq where id = $1", [l.id]);
    // Bust the cache by writing once more.
    await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: a.id, to: b.id, asset: "USDT", amount: "1" }] });
    const bad = await request(app).get(`/v1/ledgers/${l.id}/verify`).set(h);
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.chain_ok).toBe(false);
    expect(bad.body.first_bad_seq).toBe("3");
    expect(bad.body.replay_matches).toBe(false);
  });
  it("is limited to ten a minute", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "v" })).body;
    for (let i = 0; i < 10; i++) expect((await request(app).get(`/v1/ledgers/${l.id}/verify`).set(h)).status).toBe(200);
    expect((await request(app).get(`/v1/ledgers/${l.id}/verify`).set(h)).status).toBe(429);
  });

  // Whole branch review, finding 4: verifyLedgerReport called deps.cache.get and set
  // unguarded, unlike the identical caching src/routes/exchange-market-data.ts already
  // guards (readCache and writeCache there): a broken cache would have turned a perfectly
  // healthy ledger's verify call into a 500. Same fix, same proof: a cache whose get and
  // set both throw still answers 200 with the real, freshly computed report.
  it("treats a cache read or write failure as a miss, not a 500", async () => {
    const brokenCache: Cache = {
      get: async () => { throw new Error("redis unreachable"); },
      set: async () => { throw new Error("redis unreachable"); },
    };
    const { app } = await makeTestApp({ cache: brokenCache });
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "v" })).body;
    const res = await request(app).get(`/v1/ledgers/${l.id}/verify`).set(h);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, chain_ok: true, sequence_ok: true, replay_matches: true, cached: false });
  });
});
