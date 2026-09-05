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
});
