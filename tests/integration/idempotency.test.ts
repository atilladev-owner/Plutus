import { describe, it, expect } from "vitest";
import request from "supertest";
import { z } from "zod";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import { defineRoute } from "../../src/platform/route.js";
import { allRoutes } from "../../src/routes/index.js";
import { validation } from "../../src/domain/errors.js";

const probe = defineRoute({
  method: "post", path: "/probe", summary: "probe", tag: "Meta", auth: "bearer", idempotent: true,
  body: z.object({ mode: z.enum(["ok", "reject", "crash", "slow"]) }),
  response: z.object({ ok: z.boolean() }),
  handler: async ({ body }) => {
    if (body.mode === "reject") throw validation("rejected on purpose");
    if (body.mode === "crash") throw new Error("boom");
    if (body.mode === "slow") await new Promise((r) => setTimeout(r, 300));
    return { ok: true };
  },
});

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
  it("does not store a validation error, so a retry after fixing it is not refused", async () => {
    const { app } = await makeTestApp(undefined, [...allRoutes, probe]);
    const k = await mintKey(app);
    const h = { ...bearer(k.secret), "Idempotency-Key": "reject-1" };
    const a = await request(app).post("/probe").set(h).send({ mode: "reject" });
    const b = await request(app).post("/probe").set(h).send({ mode: "reject" });
    expect(a.status).toBe(422);
    expect(b.status).toBe(422);
  });
  it("does not store a crash", async () => {
    const { app } = await makeTestApp(undefined, [...allRoutes, probe]);
    const k = await mintKey(app);
    const h = { ...bearer(k.secret), "Idempotency-Key": "crash-1" };
    const a = await request(app).post("/probe").set(h).send({ mode: "crash" });
    const b = await request(app).post("/probe").set(h).send({ mode: "crash" });
    expect(a.status).toBe(500);
    expect(b.status).toBe(500);
  });
  it("stores a success before it is sent, so concurrent replays never see it in flight", async () => {
    const { app } = await makeTestApp(undefined, [...allRoutes, probe]);
    const k = await mintKey(app);
    const h = { ...bearer(k.secret), "Idempotency-Key": "ok-1" };
    const first = await request(app).post("/probe").set(h).send({ mode: "ok" });
    expect(first.status).toBe(200);
    const replays = await Promise.all(Array.from({ length: 20 }, () => request(app).post("/probe").set(h).send({ mode: "ok" })));
    for (const r of replays) {
      expect(r.status).toBe(200);
      expect(r.headers["idempotent-replayed"]).toBe("true");
    }
  });
  it("takes over a stale pending row instead of blocking the key for a day", async () => {
    const { app, deps } = await makeTestApp(undefined, [...allRoutes, probe]);
    const k = await mintKey(app);
    await deps.pool.query(
      `insert into idempotency_keys (key_id, idem_key, fingerprint, status, created_at, expires_at)
       values ($1, $2, $3, 'pending', now() - interval '2 minutes', now() + interval '24 hours')`,
      [k.id, "stale-1", Buffer.alloc(32, 0)],
    );
    const h = { ...bearer(k.secret), "Idempotency-Key": "stale-1" };
    const res = await request(app).post("/probe").set(h).send({ mode: "ok" });
    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
  });
  it("an in flight duplicate is still 409 idempotency_in_flight", async () => {
    const { app } = await makeTestApp(undefined, [...allRoutes, probe]);
    const k = await mintKey(app);
    const h = { ...bearer(k.secret), "Idempotency-Key": "slow-1" };
    // supertest/superagent requests are lazy: nothing is sent until the Request is awaited
    // or .then()-ed. Calling .then() here starts it right away instead of only once "first"
    // itself is later awaited, which is what actually makes this a race against "second".
    const first = request(app).post("/probe").set(h).send({ mode: "slow" }).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const second = await request(app).post("/probe").set(h).send({ mode: "slow" });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("idempotency_in_flight");
    expect((await first).status).toBe(200);
  });
});
