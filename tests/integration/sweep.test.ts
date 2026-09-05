import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import { SWEEP_DELETE_CAP } from "../../src/db/events.js";

describe("the sweep", () => {
  it("refuses without the secret and reports what it did with it", async () => {
    const { app, deps } = await makeTestApp();
    expect((await request(app).get("/internal/sweep")).status).toBe(401);
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "s" })).body;
    const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "a" })).body;
    await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:GHS", to: a.id, asset: "GHS", amount: "100" }] });
    const hold = (await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: a.id, amount: "10" })).body;
    await deps.pool.query("update holds set expires_at = now() - interval '1 minute' where id = $1", [hold.id]);
    const idle = await mintKey(app);
    const il = (await request(app).post("/v1/ledgers").set(bearer(idle.secret)).send({ name: "idle" })).body;
    await deps.pool.query("update ledgers set last_activity_at = now() - interval '15 days' where id = $1", [il.id]);
    await deps.pool.query("update api_keys set last_used_at = now() - interval '31 days', created_at = now() - interval '31 days' where id = $1", [idle.id]);
    const res = await request(app).get("/internal/sweep").set("Authorization", `Bearer ${deps.config.CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.expired_holds).toBeGreaterThanOrEqual(1);
    expect(res.body.deleted_ledgers).toBeGreaterThanOrEqual(1);
    expect(res.body.deleted_keys).toBeGreaterThanOrEqual(1);
    expect((await request(app).get("/v1/keys/me").set(bearer(idle.secret))).status).toBe(401);
    expect((await request(app).get(`/v1/ledgers/${l.id}/holds/${hold.id}`).set(h)).body.status).toBe("expired");
  });

  it("caps the events purge at SWEEP_DELETE_CAP and drains the rest on the next run", async () => {
    const { app, deps } = await makeTestApp();
    const k = await mintKey(app);
    const l = (await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: "backlog" })).body;
    const total = SWEEP_DELETE_CAP + 1;
    await deps.pool.query(
      `insert into events (id, key_id, ledger_id, type, entity_id, payload, created_at)
       select 'evt_backlog_' || g, $1, $2, 'test.event', 'entity', '{}'::jsonb, now() - interval '31 days'
       from generate_series(1, $3) g`,
      [k.id, l.id, total],
    );
    const auth = { Authorization: `Bearer ${deps.config.CRON_SECRET}` };
    const first = await request(app).get("/internal/sweep").set(auth);
    expect(first.status).toBe(200);
    expect(first.body.deleted_events).toBe(SWEEP_DELETE_CAP);
    const second = await request(app).get("/internal/sweep").set(auth);
    expect(second.status).toBe(200);
    expect(second.body.deleted_events).toBe(1);
    const { rows } = await deps.pool.query<{ n: string }>("select count(*)::text as n from events where id like 'evt_backlog_%'");
    expect(rows[0]?.n).toBe("0");
  });
});
