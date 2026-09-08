import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import type { RateLimiter } from "../../src/platform/ratelimit.js";

describe("rate limits", () => {
  it("limits minting per IP and says when to come back", async () => {
    const { app } = await makeTestApp();
    for (let i = 0; i < 5; i++) expect((await request(app).post("/v1/keys").set("X-Forwarded-For", "9.9.9.9").send()).status).toBe(201);
    const res = await request(app).post("/v1/keys").set("X-Forwarded-For", "9.9.9.9").send();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("rate_limited");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.headers["ratelimit-limit"]).toBe("5");
    expect((await request(app).post("/v1/keys").set("X-Forwarded-For", "8.8.8.8").send()).status).toBe(201);
  });
  it("keeps counting the trusted hop's address even when the client forges the chain", async () => {
    const { app } = await makeTestApp();
    for (let i = 0; i < 5; i++) expect((await request(app).post("/v1/keys").set("X-Forwarded-For", "9.9.9.9").send()).status).toBe(201);
    // The prepended "1.2.3.4" is the client's own forgery; with trust proxy 1, only the address
    // appended by the one trusted hop (rightmost, "9.9.9.9") governs, so this still lands on the
    // already-exhausted bucket. X-Real-IP is set too, to prove it is read nowhere.
    const res = await request(app).post("/v1/keys").set("X-Forwarded-For", "1.2.3.4, 9.9.9.9").set("X-Real-IP", "5.5.5.5").send();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("rate_limited");
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
  // Security sweep, finding 3: /health and /v1/assets both query Postgres on every call from
  // any stranger, /health Redis too, and both declared limit "none". They share one keyless
  // bucket now, keyed by address the way every other keyless bucket is, so the flood below
  // exhausts it for both routes at once from that address while another address is untouched.
  it("limits the keyless meta routes at 120 a minute per address, health included", async () => {
    const { app } = await makeTestApp();
    const ip = "7.7.7.7";
    const first = await request(app).get("/v1/assets").set("X-Forwarded-For", ip);
    expect(first.status).toBe(200);
    expect(first.headers["ratelimit-limit"]).toBe("120");
    for (let i = 0; i < 119; i++) await request(app).get("/v1/assets").set("X-Forwarded-For", ip);
    const res = await request(app).get("/v1/assets").set("X-Forwarded-For", ip);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("rate_limited");
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect((await request(app).get("/health").set("X-Forwarded-For", ip)).status).toBe(429);

    const health = await request(app).get("/health").set("X-Forwarded-For", "7.7.7.8");
    expect(health.status).toBe(200);
    expect(health.body.checks.postgres.ok).toBe(true);
    expect(health.body.checks.redis.ok).toBe(true);
  });
  it("fails closed when the limiter is down", async () => {
    const broken: RateLimiter = { limit: async () => { throw new Error("redis unreachable"); } };
    const { app } = await makeTestApp({ limiter: broken });
    const res = await request(app).post("/v1/keys").send();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("rate_limiter_unavailable");
  });
  it("fails closed when the limiter never answers", async () => {
    const hung: RateLimiter = { limit: () => new Promise(() => {}) };
    const { app } = await makeTestApp({ limiter: hung });
    const start = Date.now();
    const res = await request(app).post("/v1/keys").send();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("rate_limiter_unavailable");
  });
});
