import { describe, it, expect } from "vitest";
import request from "supertest";
import { z } from "zod";
import { makeTestApp } from "../helpers/app.js";
import { mintKey } from "../helpers/keys.js";
import { defineRoute } from "../../src/platform/route.js";
import { signRequest } from "../../src/platform/signing.js";
import { allRoutes } from "../../src/routes/index.js";

// Same two throwaway routes as tests/integration/signing.test.ts: a balance read at
// weight 5, and order placement at weight 1 plus the ten per second placement cap
// (spec 10.9). Each test file registers its own copy, same as the existing probe
// routes in tests/integration/platform.test.ts do, since neither is a production route.
const balancesProbe = defineRoute({
  method: "get", path: "/v1/exchange/balances", summary: "throwaway signed balances probe", tag: "Test",
  auth: "signed", scope: "exchange:trade", weight: 5,
  response: z.object({ ok: z.boolean() }),
  handler: async () => ({ ok: true }),
});

// Mounted under /_probe (same reasoning as tests/integration/signing.test.ts): task 5 gave
// POST /v1/exchange/orders a production handler, and a probe at that same path would now
// be shadowed by it instead of testing the placement cap in isolation.
const orderProbe = defineRoute({
  method: "post", path: "/v1/exchange/_probe/orders", summary: "throwaway signed order placement probe", tag: "Test",
  auth: "signed", scope: "exchange:trade", weight: 1, placement: true,
  body: z.object({}).optional(),
  response: z.object({ ok: z.boolean() }),
  handler: async () => ({ ok: true }),
});

function sign(keyId: string, secret: string, method: string, path: string) {
  return signRequest({ keyId, secret, method, path, timestamp: Date.now() });
}

describe("endpoint weights", () => {
  it("charges weight per call and refuses once 1,200 is spent inside a minute", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const k = await mintKey(app);
    // weight 5 per call; 240 calls spend exactly the 1,200 point budget.
    for (let i = 0; i < 240; i++) {
      const res = await request(app).get("/v1/exchange/balances").set(sign(k.id, k.secret, "GET", "/v1/exchange/balances"));
      expect(res.status).toBe(200);
    }
    const res = await request(app).get("/v1/exchange/balances").set(sign(k.id, k.secret, "GET", "/v1/exchange/balances"));
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("rate_limited");
    expect(res.headers["ratelimit-remaining"]).toBe("0");
  });

  it("keeps a per key weight budget separate from another key's", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe]);
    const a = await mintKey(app);
    const b = await mintKey(app);
    for (let i = 0; i < 240; i++) await request(app).get("/v1/exchange/balances").set(sign(a.id, a.secret, "GET", "/v1/exchange/balances"));
    expect((await request(app).get("/v1/exchange/balances").set(sign(a.id, a.secret, "GET", "/v1/exchange/balances"))).status).toBe(429);
    expect((await request(app).get("/v1/exchange/balances").set(sign(b.id, b.secret, "GET", "/v1/exchange/balances"))).status).toBe(200);
  });

  it("caps placement at ten a second while a balance read on the same key still passes", async () => {
    const { app } = await makeTestApp({}, [...allRoutes, balancesProbe, orderProbe]);
    const k = await mintKey(app);
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post("/v1/exchange/_probe/orders").set(sign(k.id, k.secret, "POST", "/v1/exchange/_probe/orders")).send();
      expect(res.status).toBe(200);
    }
    const eleventh = await request(app).post("/v1/exchange/_probe/orders").set(sign(k.id, k.secret, "POST", "/v1/exchange/_probe/orders")).send();
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.code).toBe("rate_limited");
    const read = await request(app).get("/v1/exchange/balances").set(sign(k.id, k.secret, "GET", "/v1/exchange/balances"));
    expect(read.status).toBe(200);
  });
});
