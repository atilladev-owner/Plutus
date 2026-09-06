import { describe, it, expect } from "vitest";
import request from "supertest";
import { z } from "zod";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import { defineRoute } from "../../src/platform/route.js";
import { signRequest } from "../../src/platform/signing.js";
import { allRoutes } from "../../src/routes/index.js";

// Throwaway routes standing in for the real exchange endpoints task 2 has to authenticate
// against. Weights match spec 10.9: a balance read is 5, order placement is 1 plus the per
// second placement cap. Mounted under /_probe so they never collide with the real routes:
// task 3 gave GET /v1/exchange/balances a production handler, and a probe at that same
// path would now shadow it and answer with the probe's own body instead of testing auth.
const balancesProbe = defineRoute({
  method: "get", path: "/v1/exchange/_probe/balances", summary: "throwaway signed balances probe", tag: "Test",
  auth: "signed", scope: "exchange:trade", weight: 5,
  response: z.object({ ok: z.boolean() }),
  handler: async () => ({ ok: true }),
});

const orderProbe = defineRoute({
  method: "post", path: "/v1/exchange/_probe/orders", summary: "throwaway signed order placement probe", tag: "Test",
  auth: "signed", scope: "exchange:trade", weight: 1, placement: true,
  body: z.object({ client_order_id: z.string() }).optional(),
  response: z.object({ ok: z.boolean() }),
  handler: async () => ({ ok: true }),
});

describe("signed requests", () => {
  it("authenticates a correctly signed GET", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const k = await mintKey(app);
    const headers = signRequest({ keyId: k.id, secret: k.secret, method: "GET", path: "/v1/exchange/_probe/balances", timestamp: Date.now() });
    const res = await request(app).get("/v1/exchange/_probe/balances").set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("refuses a request missing the signature headers", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const res = await request(app).get("/v1/exchange/_probe/balances");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_signature");
  });

  it("refuses a timestamp outside the default five second window", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const k = await mintKey(app);
    const timestamp = Date.now() - 6000;
    const headers = signRequest({ keyId: k.id, secret: k.secret, method: "GET", path: "/v1/exchange/_probe/balances", timestamp });
    const res = await request(app).get("/v1/exchange/_probe/balances").set(headers);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("timestamp_out_of_window");
  });

  it("refuses a timestamp six seconds in the future too", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const k = await mintKey(app);
    const timestamp = Date.now() + 6000;
    const headers = signRequest({ keyId: k.id, secret: k.secret, method: "GET", path: "/v1/exchange/_probe/balances", timestamp });
    const res = await request(app).get("/v1/exchange/_probe/balances").set(headers);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("timestamp_out_of_window");
  });

  it("accepts the same old timestamp once the caller widens the receive window", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const k = await mintKey(app);
    const timestamp = Date.now() - 6000;
    const headers = signRequest({ keyId: k.id, secret: k.secret, method: "GET", path: "/v1/exchange/_probe/balances", timestamp, recvWindow: 10000 });
    const res = await request(app).get("/v1/exchange/_probe/balances").set(headers);
    expect(res.status).toBe(200);
  });

  it("clamps a receive window above sixty thousand back down to sixty thousand", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const k = await mintKey(app);
    // 65s old: inside the 120s window asked for, outside the 60s ceiling the server clamps to.
    const timestamp = Date.now() - 65_000;
    const headers = signRequest({ keyId: k.id, secret: k.secret, method: "GET", path: "/v1/exchange/_probe/balances", timestamp, recvWindow: 120_000 });
    const res = await request(app).get("/v1/exchange/_probe/balances").set(headers);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("timestamp_out_of_window");
  });

  it("refuses a body that does not match what was signed", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, orderProbe]);
    const k = await mintKey(app);
    const timestamp = Date.now();
    const headers = signRequest({
      keyId: k.id, secret: k.secret, method: "POST", path: "/v1/exchange/_probe/orders", timestamp,
      body: JSON.stringify({ client_order_id: "a" }),
    });
    const res = await request(app).post("/v1/exchange/_probe/orders").set(headers).send({ client_order_id: "b" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_signature");
  });

  it("refuses a bearer token presented to a signed route", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const k = await mintKey(app);
    const res = await request(app).get("/v1/exchange/_probe/balances").set(bearer(k.secret));
    expect(res.status).toBe(401);
  });

  it("refuses an unknown key id exactly like a bad signature, so ids cannot be probed", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const headers = signRequest({ keyId: "key_doesnotexist", secret: "whatever-secret", method: "GET", path: "/v1/exchange/_probe/balances", timestamp: Date.now() });
    const res = await request(app).get("/v1/exchange/_probe/balances").set(headers);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_signature");
  });

  it("honours the same rotation grace period as bearer auth, then refuses once it expires", async () => {
    const { app, deps } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const first = await mintKey(app);
    const rotated = (await request(app).post("/v1/keys/rotate").set(bearer(first.secret)).send()).body as { secret: string };
    // Still inside the fifteen minute grace period: the old secret still signs successfully,
    // with the warning header the same way bearerAuth warns about disabled webhook endpoints.
    const stillValid = await request(app)
      .get("/v1/exchange/_probe/balances")
      .set(signRequest({ keyId: first.id, secret: first.secret, method: "GET", path: "/v1/exchange/_probe/balances", timestamp: Date.now() }));
    expect(stillValid.status).toBe(200);
    expect(stillValid.headers["plutus-warning"]).toMatch(/rotated secret/);
    // Expire the retiring row directly, the same way tests/integration/keys.test.ts does for bearer auth.
    await deps.pool.query("update api_key_old_secrets set expires_at = now() - interval '1 second' where key_id = $1", [first.id]);
    const expired = await request(app)
      .get("/v1/exchange/_probe/balances")
      .set(signRequest({ keyId: first.id, secret: first.secret, method: "GET", path: "/v1/exchange/_probe/balances", timestamp: Date.now() }));
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe("invalid_signature");
    // The new secret still works throughout.
    const withNewSecret = await request(app)
      .get("/v1/exchange/_probe/balances")
      .set(signRequest({ keyId: first.id, secret: rotated.secret, method: "GET", path: "/v1/exchange/_probe/balances", timestamp: Date.now() }));
    expect(withNewSecret.status).toBe(200);
  });
});
