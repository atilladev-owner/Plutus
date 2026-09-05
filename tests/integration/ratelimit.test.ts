import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import type { RateLimiter } from "../../src/platform/ratelimit.js";

describe("rate limits", () => {
  it("limits minting per IP and says when to come back", async () => {
    const { app } = await makeTestApp();
    for (let i = 0; i < 5; i++) expect((await request(app).post("/v1/keys").set("X-Real-IP", "9.9.9.9").send()).status).toBe(201);
    const res = await request(app).post("/v1/keys").set("X-Real-IP", "9.9.9.9").send();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("rate_limited");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.headers["ratelimit-limit"]).toBe("5");
    expect((await request(app).post("/v1/keys").set("X-Real-IP", "8.8.8.8").send()).status).toBe(201);
  });
  it("limits a sandbox key at sixty a minute with headers on every response", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const first = await request(app).get("/v1/keys/me").set(bearer(k.secret));
    expect(first.headers["ratelimit-limit"]).toBe("60");
    expect(first.headers["ratelimit-remaining"]).toBe("59");
    for (let i = 0; i < 59; i++) await request(app).get("/v1/keys/me").set(bearer(k.secret));
    expect((await request(app).get("/v1/keys/me").set(bearer(k.secret))).status).toBe(429);
  });
  it("fails closed when the limiter is down", async () => {
    const broken: RateLimiter = { limit: async () => { throw new Error("redis unreachable"); } };
    const { app } = await makeTestApp({ limiter: broken });
    const res = await request(app).post("/v1/keys").send();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("rate_limiter_unavailable");
  });
});
