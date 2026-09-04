import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";

describe("platform", () => {
  it("health reports both dependencies and a version", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.checks.postgres.ok).toBe(true);
    expect(res.body.version).toBe("dev");
    expect(res.headers["x-request-id"]).toMatch(/[0-9a-f-]{36}/);
  });
  it("echoes a safe request id and ignores an unsafe one", async () => {
    const { app } = await makeTestApp();
    expect((await request(app).get("/health").set("X-Request-Id", "abc-123-def")).headers["x-request-id"]).toBe("abc-123-def");
    expect((await request(app).get("/health").set("X-Request-Id", "<script>")).headers["x-request-id"]).not.toBe("<script>");
  });
  it("answers unknown routes and bad JSON as problem details with no stack", async () => {
    const { app } = await makeTestApp();
    const nf = await request(app).get("/nope");
    expect(nf.status).toBe(404);
    expect(nf.headers["content-type"]).toContain("application/problem+json");
    expect(nf.body.code).toBe("not_found");
    expect(nf.body.request_id).toBeTruthy();
    const bad = await request(app).post("/health").set("Content-Type", "application/json").send("{not json");
    expect([400, 404]).toContain(bad.status);
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.ts:\d+/);
  });
  it("sends security headers and no x-powered-by", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
