import { describe, it, expect } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";

async function seed(app: Express) {
  const k = await mintKey(app);
  const h = bearer(k.secret);
  const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "x" })).body;
  const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "USD", name: "a" })).body;
  const b = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "USD", name: "b" })).body;
  return { k, h, l, a, b };
}

describe("transfers over HTTP", () => {
  it("funds from the world, moves money, reads back with legs, and lists by account", async () => {
    const { app } = await makeTestApp();
    const { h, l, a, b } = await seed(app);
    const fund = await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:USD", to: a.id, asset: "USD", amount: "5000" }], memo: "deposit" });
    expect(fund.status).toBe(201);
    expect(fund.body.seq).toBe("1");
    expect(fund.body.legs[0]).toMatchObject({ position: 0, to: a.id, asset: "USD", amount: "5000", from_hold: null });
    expect(fund.body.legs[0].from).toMatch(/^acct_/);
    const move = await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: a.id, to: b.id, asset: "USD", amount: "1250" }] });
    expect(move.status).toBe(201);
    const acc = await request(app).get(`/v1/ledgers/${l.id}/accounts/${a.id}`).set(h);
    expect(acc.body).toMatchObject({ balance: "3750", held: "0", available: "3750" });
    const one = await request(app).get(`/v1/ledgers/${l.id}/transfers/${move.body.id}`).set(h);
    expect(one.body.legs).toHaveLength(1);
    const byB = await request(app).get(`/v1/ledgers/${l.id}/transfers?account=${b.id}`).set(h);
    expect(byB.body.data.map((t: { id: string }) => t.id)).toEqual([move.body.id]);
  });
  it("returns problem details for an overdraft and for a number amount", async () => {
    const { app } = await makeTestApp();
    const { h, l, a, b } = await seed(app);
    const od = await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: a.id, to: b.id, asset: "USD", amount: "1" }] });
    expect(od.status).toBe(409);
    expect(od.body.code).toBe("insufficient_funds");
    expect(od.body.detail).toContain("leg 0");
    const num = await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:USD", to: a.id, asset: "USD", amount: 100 }] });
    expect(num.status).toBe(422);
    expect(num.body.errors[0].path).toBe("legs.0.amount");
  });
  it("cannot touch another key's ledger", async () => {
    const { app } = await makeTestApp();
    const mine = await seed(app);
    const theirs = await seed(app);
    const res = await request(app).post(`/v1/ledgers/${theirs.l.id}/transfers`).set(mine.h).send({ legs: [{ from: "world:USD", to: theirs.a.id, asset: "USD", amount: "1" }] });
    expect(res.status).toBe(404);
  });
  it("reads the journal oldest first with a since cursor", async () => {
    const { app } = await makeTestApp();
    const { h, l, a } = await seed(app);
    for (let i = 0; i < 3; i++) await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:USD", to: a.id, asset: "USD", amount: "10" }] });
    const j = await request(app).get(`/v1/ledgers/${l.id}/journal?since=1`).set(h);
    expect(j.body.data.map((e: { seq: string }) => e.seq)).toEqual(["2", "3"]);
    expect(j.body.data[0].kind).toBe("transfer.posted");
    expect(j.body.data[0].hash).toMatch(/^[0-9a-f]{64}$/);
    const ev = await request(app).get("/v1/events?type=transfer.posted").set(h);
    expect(ev.body.data.length).toBe(3);
  });
  it("stores the idempotent reply in the same transaction as the transfer it posted", async () => {
    const { app, deps } = await makeTestApp();
    const { h, l, a } = await seed(app);
    const res = await request(app).post(`/v1/ledgers/${l.id}/transfers`).set({ ...h, "Idempotency-Key": "t-1" }).send({ legs: [{ from: "world:USD", to: a.id, asset: "USD", amount: "10" }] });
    expect(res.status).toBe(201);
    const { rows } = await deps.pool.query("select status, response_status, response_body from idempotency_keys where idem_key = $1", ["t-1"]);
    expect(rows[0].status).toBe("done");
    expect(rows[0].response_status).toBe(201);
    expect(rows[0].response_body.id).toBe(res.body.id);
  });
});
