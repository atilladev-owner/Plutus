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
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    const bb = await request(app).get(`/v1/ledgers/${l.id}/accounts/${b.id}`).set(h);
    expect(bb.body.balance).toBe("500");
    const v = await request(app).get(`/v1/ledgers/${l.id}/verify`).set(h);
    expect(v.body.ok).toBe(true);
  });
});
