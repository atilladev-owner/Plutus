import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";

describe("deleting a ledger", () => {
  it("cascades through accounts, holds and transfer legs in one statement", async () => {
    const { app, deps } = await makeTestApp();
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "cascade" })).body;
    const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "a" })).body;
    const b = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "b" })).body;
    expect((await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:GHS", to: a.id, asset: "GHS", amount: "100" }] })).status).toBe(201);
    expect((await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: a.id, to: b.id, asset: "GHS", amount: "40" }] })).status).toBe(201);
    expect((await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: b.id, amount: "5" })).status).toBe(201);
    const direct = await deps.pool.query("delete from ledgers where id = $1", [l.id]);
    expect(direct.rowCount).toBe(1);
  });
});
