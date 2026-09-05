import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";

describe("idempotency", () => {
  it("replays the first response for the same key and body", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const h = { ...bearer(k.secret), "Idempotency-Key": "rot-1" };
    const a = await request(app).post("/v1/keys/rotate").set(h).send({});
    const b = await request(app).post("/v1/keys/rotate").set(h).send({});
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.secret).toBe(a.body.secret);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(a.headers["idempotent-replayed"]).toBeUndefined();
  });
  it("refuses the same key with a different body", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const l = (await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: "x" })).body;
    const h = { ...bearer(k.secret), "Idempotency-Key": "acct-1" };
    expect((await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "one" })).status).toBe(201);
    const res = await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "two" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("idempotency_key_reused");
  });
  it("scopes keys per API key and ignores requests without the header", async () => {
    const { app } = await makeTestApp();
    const k1 = await mintKey(app);
    const k2 = await mintKey(app);
    const a = await request(app).post("/v1/keys/rotate").set({ ...bearer(k1.secret), "Idempotency-Key": "same" }).send({});
    const b = await request(app).post("/v1/keys/rotate").set({ ...bearer(k2.secret), "Idempotency-Key": "same" }).send({});
    expect(a.body.secret).not.toBe(b.body.secret);
    const c = await request(app).post("/v1/keys/rotate").set(bearer(b.body.secret)).send({});
    const d = await request(app).post("/v1/keys/rotate").set(bearer(c.body.secret)).send({});
    expect(c.body.secret).not.toBe(d.body.secret);
  });
});
