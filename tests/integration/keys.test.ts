import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";

describe("keys", () => {
  it("mints a sandbox key once and never shows the secret again", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).post("/v1/keys").send();
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^pl_test_/);
    expect(res.body.mode).toBe("test");
    expect(res.body.scopes).toEqual(["ledger:read", "ledger:write", "webhooks:manage", "exchange:trade"]);
    const me = await request(app).get("/v1/keys/me").set("Authorization", `Bearer ${res.body.secret}`);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(res.body.id);
    expect(me.body.secret).toBeUndefined();
    expect(me.body.last4).toBe(res.body.secret.slice(-4));
  });
  it("refuses missing, malformed and unknown keys, and never says which", async () => {
    const { app } = await makeTestApp();
    for (const header of [undefined, "Bearer", "Bearer nope", "Basic abc", `Bearer pl_test_${"a".repeat(43)}`]) {
      const r = header ? request(app).get("/v1/keys/me").set("Authorization", header) : request(app).get("/v1/keys/me");
      const res = await r;
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("unauthorized");
      expect(res.body.detail).not.toMatch(/unknown|revoked|expired/);
    }
  });
  it("rotates: the new secret works, the old one dies after the grace period", async () => {
    const { app, deps } = await makeTestApp();
    const first = (await request(app).post("/v1/keys").send()).body;
    const rot = await request(app).post("/v1/keys/rotate").set("Authorization", `Bearer ${first.secret}`).send();
    expect(rot.status).toBe(201);
    expect(rot.body.id).toBe(first.id);
    expect(rot.body.secret).not.toBe(first.secret);
    expect((await request(app).get("/v1/keys/me").set("Authorization", `Bearer ${rot.body.secret}`)).status).toBe(200);
    expect((await request(app).get("/v1/keys/me").set("Authorization", `Bearer ${first.secret}`)).status).toBe(200);
    await deps.pool.query("update api_key_old_secrets set expires_at = now() - interval '1 second' where key_id = $1", [first.id]);
    expect((await request(app).get("/v1/keys/me").set("Authorization", `Bearer ${first.secret}`)).status).toBe(401);
    expect((await request(app).get("/v1/keys/me").set("Authorization", `Bearer ${rot.body.secret}`)).status).toBe(200);
  });
  it("replays the stored reply for a repeated Idempotency-Key instead of rotating again", async () => {
    const { app, deps } = await makeTestApp();
    const k = await mintKey(app);
    const h = { ...bearer(k.secret), "Idempotency-Key": "rotate-1" };
    const a = await request(app).post("/v1/keys/rotate").set(h).send({});
    const b = await request(app).post("/v1/keys/rotate").set(h).send({});
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.secret).toBe(a.body.secret);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(a.headers["idempotent-replayed"]).toBeUndefined();
    const { rows } = await deps.pool.query<{ n: string }>("select count(*)::text as n from api_key_old_secrets where key_id = $1", [k.id]);
    expect(rows[0]?.n).toBe("1");
  });

  it("lists assets without a key", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/v1/assets");
    expect(res.status).toBe(200);
    expect(res.body.data.map((a: { code: string }) => a.code)).toEqual(["BTC", "ETH", "GHS", "HKD", "USD", "USDT"]);
  });
});
