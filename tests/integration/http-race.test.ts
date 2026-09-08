import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";

describe("the race, through the API", () => {
  it("parallel captures of one hold never overdraw it", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "r" })).body;
    const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "USD", name: "a" })).body;
    const b = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "USD", name: "b" })).body;
    await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:USD", to: a.id, asset: "USD", amount: "1000" }] });
    const hold = (await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: a.id, amount: "500" })).body;
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      request(app).post(`/v1/ledgers/${l.id}/holds/${hold.id}/capture`).set(h).send({ to: b.id, amount: "100" })));
    // Every response must be a genuine capture or a genuine refusal; a pool timeout
    // surfacing as a 500 would otherwise just shift the counts below and read like a
    // ledger bug instead of the infrastructure problem it actually is. Five hundred
    // divides evenly by the hundred each capture asks for, so the fifth winner always
    // closes the hold in the same statement that brings its remaining to zero; every
    // loser after that sees a closed hold, not a short one, so post_transfer's status
    // check fires before its remaining check ever would. The seven losers are always
    // hold_not_open here, never insufficient_funds; both are genuine 409 refusals, so
    // the assertion accepts either rather than asserting the one this race cannot
    // actually produce.
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    const overdrawn = results.filter((r) => r.status === 409);
    expect(overdrawn).toHaveLength(7);
    for (const r of overdrawn) expect(["insufficient_funds", "hold_not_open"]).toContain(r.body.code);
    const bb = await request(app).get(`/v1/ledgers/${l.id}/accounts/${b.id}`).set(h);
    expect(bb.body.balance).toBe("500");
    const v = await request(app).get(`/v1/ledgers/${l.id}/verify`).set(h);
    expect(v.body.ok).toBe(true);
  });

  // Security sweep, finding 4 (important): each sandbox ceiling was a select count(*) then an
  // insert, in one transaction but with nothing locked between them, so concurrent creates
  // for one key all read the same count, all saw room and all inserted. The owning row is
  // locked before the count now (src/db/locks.ts). Eleven and six at once rather than two:
  // one extra request would pass on a lucky interleaving even against the old code, while a
  // whole batch past the ceiling makes the failure certain rather than occasional.
  it("never exceeds the ten ledger ceiling under eleven concurrent creates for one key", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const results = await Promise.all(Array.from({ length: 11 }, (_, i) =>
      request(app).post("/v1/ledgers").set(h).send({ name: `race-${i}` })));
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    for (const r of results.filter((r) => r.status === 409)) expect(r.body.code).toBe("sandbox_limit_reached");
    const list = await request(app).get("/v1/ledgers").set(h);
    expect(list.body.data).toHaveLength(10);
  });

  it("never exceeds the five webhook endpoint ceiling under six concurrent registrations for one key", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const h = bearer(k.secret);
    // Three registered first, then six at once. Firing all six against an empty account
    // would prove nothing: the pool holds five connections (src/db/pool.ts), so at most five
    // of them can ever be in flight together, and five requests that all count zero insert
    // exactly five, the ceiling, even with no lock at all. Starting three short of the
    // ceiling is what puts the boundary inside the concurrent batch, where the race is.
    for (let i = 0; i < 3; i++) {
      expect((await request(app).post("/v1/webhooks").set(h).send({ url: `https://example.com/seed-${i}`, events: ["*"] })).status).toBe(201);
    }
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      request(app).post("/v1/webhooks").set(h).send({ url: `https://example.com/hook-${i}`, events: ["*"] })));
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    for (const r of results.filter((r) => r.status === 409)) expect(r.body.code).toBe("sandbox_limit_reached");
    const list = await request(app).get("/v1/webhooks").set(h);
    expect(list.body.data).toHaveLength(5);
  });

  it("never exceeds the fifty account ceiling under concurrent creates for one ledger", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "accounts" })).body;
    // Forty five sequentially, to get close to the ceiling cheaply, then eight at once across
    // it: the race is only ever at the boundary, and one ledger create plus forty five plus
    // eight is fifty four requests, inside the sandbox key's own sixty a minute budget.
    for (let i = 0; i < 45; i++) {
      expect((await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "USD", name: `a${i}` })).status).toBe(201);
    }
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "USD", name: `race-${i}` })));
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    for (const r of results.filter((r) => r.status === 409)) expect(r.body.code).toBe("sandbox_limit_reached");
  });
});
