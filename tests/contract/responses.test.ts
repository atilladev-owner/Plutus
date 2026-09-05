import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { bearer } from "../helpers/keys.js";
import { ROUTE_REGISTRY } from "../../src/platform/route.js";
import { Problem } from "../../src/schemas/common.js";

function schemaFor(method: string, path: string) {
  const r = ROUTE_REGISTRY.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`no route ${method} ${path}`);
  return r.response;
}

describe("responses match their declared schemas", () => {
  it("across a whole ledger session", async () => {
    const { app } = await makeTestApp();
    const minted = await request(app).post("/v1/keys").send();
    expect(schemaFor("post", "/v1/keys").safeParse(minted.body).success).toBe(true);
    const h = bearer(minted.body.secret);
    const l = await request(app).post("/v1/ledgers").set(h).send({ name: "c" });
    expect(schemaFor("post", "/v1/ledgers").safeParse(l.body).success).toBe(true);
    const a = await request(app).post(`/v1/ledgers/${l.body.id}/accounts`).set(h).send({ asset: "USD", name: "a" });
    expect(schemaFor("post", "/v1/ledgers/{id}/accounts").safeParse(a.body).success).toBe(true);
    const t = await request(app).post(`/v1/ledgers/${l.body.id}/transfers`).set(h).send({ legs: [{ from: "world:USD", to: a.body.id, asset: "USD", amount: "10" }] });
    expect(schemaFor("post", "/v1/ledgers/{id}/transfers").safeParse(t.body).success).toBe(true);
    const hold = await request(app).post(`/v1/ledgers/${l.body.id}/holds`).set(h).send({ account: a.body.id, amount: "5" });
    expect(schemaFor("post", "/v1/ledgers/{id}/holds").safeParse(hold.body).success).toBe(true);
    const v = await request(app).get(`/v1/ledgers/${l.body.id}/verify`).set(h);
    expect(schemaFor("get", "/v1/ledgers/{id}/verify").safeParse(v.body).success).toBe(true);
    const j = await request(app).get(`/v1/ledgers/${l.body.id}/journal`).set(h);
    expect(schemaFor("get", "/v1/ledgers/{id}/journal").safeParse(j.body).success).toBe(true);
    const e = await request(app).get("/v1/events").set(h);
    expect(schemaFor("get", "/v1/events").safeParse(e.body).success).toBe(true);
    const bad = await request(app).post(`/v1/ledgers/${l.body.id}/transfers`).set(h).send({ legs: [] });
    expect(Problem.safeParse(bad.body).success).toBe(true);
  });
});
