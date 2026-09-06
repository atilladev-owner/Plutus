import { describe, it, expect } from "vitest";
import request from "supertest";
import { z } from "zod";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import { defineRoute } from "../../src/platform/route.js";
import { signRequest } from "../../src/platform/signing.js";
import { allRoutes } from "../../src/routes/index.js";

// Throwaway routes standing in for the real exchange endpoints task 2 has to authenticate
// against, before any of them exist. Weights match spec 10.9: a balance read is 5, order
// placement is 1 plus the per second placement cap.
const balancesProbe = defineRoute({
  method: "get", path: "/v1/exchange/balances", summary: "throwaway signed balances probe", tag: "Test",
  auth: "signed", scope: "exchange:trade", weight: 5,
  response: z.object({ ok: z.boolean() }),
  handler: async () => ({ ok: true }),
});

const orderProbe = defineRoute({
  method: "post", path: "/v1/exchange/orders", summary: "throwaway signed order placement probe", tag: "Test",
  auth: "signed", scope: "exchange:trade", weight: 1, placement: true,
  body: z.object({ client_order_id: z.string() }).optional(),
  response: z.object({ ok: z.boolean() }),
  handler: async () => ({ ok: true }),
});

describe("signed requests", () => {
  it("authenticates a correctly signed GET", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const k = await mintKey(app);
    const headers = signRequest({ keyId: k.id, secret: k.secret, method: "GET", path: "/v1/exchange/balances", timestamp: Date.now() });
    const res = await request(app).get("/v1/exchange/balances").set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("refuses a request missing the signature headers", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const res = await request(app).get("/v1/exchange/balances");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_signature");
  });

  it("refuses a timestamp outside the default five second window", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const k = await mintKey(app);
    const timestamp = Date.now() - 6000;
    const headers = signRequest({ keyId: k.id, secret: k.secret, method: "GET", path: "/v1/exchange/balances", timestamp });
    const res = await request(app).get("/v1/exchange/balances").set(headers);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("timestamp_out_of_window");
  });

  it("refuses a timestamp six seconds in the future too", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const k = await mintKey(app);
    const timestamp = Date.now() + 6000;
    const headers = signRequest({ keyId: k.id, secret: k.secret, method: "GET", path: "/v1/exchange/balances", timestamp });
    const res = await request(app).get("/v1/exchange/balances").set(headers);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("timestamp_out_of_window");
  });

  it("accepts the same old timestamp once the caller widens the receive window", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const k = await mintKey(app);
    const timestamp = Date.now() - 6000;
    const headers = signRequest({ keyId: k.id, secret: k.secret, method: "GET", path: "/v1/exchange/balances", timestamp, recvWindow: 10000 });
    const res = await request(app).get("/v1/exchange/balances").set(headers);
    expect(res.status).toBe(200);
  });

  it("clamps a receive window above sixty thousand back down to sixty thousand", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const k = await mintKey(app);
    // 65s old: inside the 120s window asked for, outside the 60s ceiling the server clamps to.
    const timestamp = Date.now() - 65_000;
    const headers = signRequest({ keyId: k.id, secret: k.secret, method: "GET", path: "/v1/exchange/balances", timestamp, recvWindow: 120_000 });
    const res = await request(app).get("/v1/exchange/balances").set(headers);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("timestamp_out_of_window");
  });

  it("refuses a body that does not match what was signed", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, orderProbe]);
    const k = await mintKey(app);
    const timestamp = Date.now();
    const headers = signRequest({
      keyId: k.id, secret: k.secret, method: "POST", path: "/v1/exchange/orders", timestamp,
      body: JSON.stringify({ client_order_id: "a" }),
    });
    const res = await request(app).post("/v1/exchange/orders").set(headers).send({ client_order_id: "b" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_signature");
  });

  it("refuses a bearer token presented to a signed route", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const k = await mintKey(app);
    const res = await request(app).get("/v1/exchange/balances").set(bearer(k.secret));
    expect(res.status).toBe(401);
  });

  it("refuses an unknown key id exactly like a bad signature, so ids cannot be probed", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const headers = signRequest({ keyId: "key_doesnotexist", secret: "whatever-secret", method: "GET", path: "/v1/exchange/balances", timestamp: Date.now() });
    const res = await request(app).get("/v1/exchange/balances").set(headers);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_signature");
  });
});
