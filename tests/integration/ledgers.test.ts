import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";

describe("ledgers and accounts", () => {
  it("creates, reads and lists ledgers, and never shows another key's ledger", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const other = await mintKey(app);
    const created = await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: "shop" });
    expect(created.status).toBe(201);
    expect(created.body.id).toMatch(/^ldg_[0-9a-f]{32}$/);
    expect(created.body.next_seq).toBe("1");
    expect(created.body.head_hash).toBe("0".repeat(64));
    expect((await request(app).get(`/v1/ledgers/${created.body.id}`).set(bearer(k.secret))).status).toBe(200);
    expect((await request(app).get(`/v1/ledgers/${created.body.id}`).set(bearer(other.secret))).status).toBe(404);
    const list = await request(app).get("/v1/ledgers").set(bearer(k.secret));
    expect(list.body.data.map((l: { id: string }) => l.id)).toEqual([created.body.id]);
    expect(list.body.next_cursor).toBeNull();
  });
  it("validates names and enforces the ten ledger ceiling", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const bad = await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: "" });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("validation_failed");
    expect(bad.body.errors[0].path).toBe("name");
    for (let i = 0; i < 10; i++) expect((await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: `l${i}` })).status).toBe(201);
    const over = await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: "eleven" });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe("sandbox_limit_reached");
    expect(over.body.detail).toContain("ledgers");
  });
  it("creates accounts with balance, held and available, and paginates newest first", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const l = (await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: "x" })).body;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(bearer(k.secret)).send({ asset: "GHS", name: `a${i}`, metadata: { note: "n" } });
      expect(a.status).toBe(201);
      expect(a.body).toMatchObject({ asset: "GHS", balance: "0", held: "0", available: "0", kind: "normal", metadata: { note: "n" } });
      ids.push(a.body.id);
    }
    const p1 = await request(app).get(`/v1/ledgers/${l.id}/accounts?limit=2`).set(bearer(k.secret));
    expect(p1.body.data.map((a: { id: string }) => a.id)).toEqual([ids[2], ids[1]]);
    expect(p1.body.next_cursor).toBeTruthy();
    const p2 = await request(app).get(`/v1/ledgers/${l.id}/accounts?limit=2&cursor=${encodeURIComponent(p1.body.next_cursor)}`).set(bearer(k.secret));
    expect(p2.body.data.map((a: { id: string }) => a.id)).toEqual([ids[0]]);
    expect(p2.body.next_cursor).toBeNull();
    expect((await request(app).get(`/v1/ledgers/${l.id}/accounts?cursor=garbage`).set(bearer(k.secret))).status).toBe(422);
  });
  it("rejects an unknown asset, bad metadata, and a JSON number amount later", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const l = (await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: "x" })).body;
    expect((await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(bearer(k.secret)).send({ asset: "XXX", name: "a" })).status).toBe(422);
    expect((await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(bearer(k.secret)).send({ asset: "GHS", name: "a", metadata: { "bad key!": "x" } })).status).toBe(422);
  });
});
