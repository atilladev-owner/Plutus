import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import { verifySignature } from "../../src/platform/webhook-sign.js";
import { deliverOnce } from "../../src/platform/deliver.js";
import { MemoryScheduler } from "../../src/platform/scheduler.js";

interface Received { body: string; headers: Record<string, string | string[] | undefined> }

function receiver(status: () => number): Promise<{ url: string; got: Received[]; close: () => void }> {
  const got: Received[] = [];
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { got.push({ body, headers: req.headers }); res.statusCode = status(); res.end("ok"); });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/hook`, got, close: () => server.close() });
    });
  });
}

describe("webhooks", () => {
  it("registers an endpoint, delivers a signed event, and the verifier accepts it", async () => {
    const { app, deps } = await makeTestApp();
    // Deliver at once when scheduled with zero delay, the way QStash would a moment later.
    const scheduler = new MemoryScheduler((id) => deliverOnce(deps, id));
    deps.scheduler = scheduler;
    const rx = await receiver(() => 200);
    try {
      const k = await mintKey(app);
      const h = bearer(k.secret);
      const ep = await request(app).post("/v1/webhooks").set(h).send({ url: rx.url.replace("http://", "https://"), events: ["transfer.posted"] });
      expect(ep.status).toBe(201);
      expect(ep.body.secret).toMatch(/^whsec_/);
      // Tests may point at http; production requires https. Flip the stored url back for the local receiver.
      await deps.pool.query("update webhook_endpoints set url = $2 where id = $1", [ep.body.id, rx.url]);
      const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "w" })).body;
      const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "a" })).body;
      await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:GHS", to: a.id, asset: "GHS", amount: "100" }] });
      expect(rx.got).toHaveLength(1);
      const sig = rx.got[0]!.headers["plutus-signature"] as string;
      expect(verifySignature(ep.body.secret, sig, rx.got[0]!.body, Math.trunc(Date.now() / 1000))).toBe(true);
      const body = JSON.parse(rx.got[0]!.body);
      expect(body.type).toBe("transfer.posted");
      expect(rx.got[0]!.headers["plutus-event-id"]).toBe(body.id);
      const dl = await request(app).get(`/v1/webhooks/${ep.body.id}/deliveries`).set(h);
      expect(dl.body.data[0]).toMatchObject({ status: "succeeded", attempt: 1, response_status: 200 });
      // A hold event is not subscribed, so nothing more arrives.
      await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: a.id, amount: "1" });
      expect(rx.got).toHaveLength(1);
    } finally { rx.close(); }
  });

  it("retries with the schedule, dies after eight, and can be retried by hand", async () => {
    const { app, deps } = await makeTestApp();
    const scheduler = new MemoryScheduler();
    deps.scheduler = scheduler;
    const rx = await receiver(() => 500);
    try {
      const k = await mintKey(app);
      const h = bearer(k.secret);
      const ep = (await request(app).post("/v1/webhooks").set(h).send({ url: "https://example.com/x", events: ["*"] })).body;
      await deps.pool.query("update webhook_endpoints set url = $2 where id = $1", [ep.id, rx.url]);
      const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "w" })).body;
      await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "a" });
      const a = (await request(app).get(`/v1/ledgers/${l.id}/accounts`).set(h)).body.data[0];
      await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:GHS", to: a.id, asset: "GHS", amount: "100" }] });
      expect(scheduler.scheduled).toEqual([{ deliveryId: expect.stringMatching(/^whd_/), delaySeconds: 0 }]);
      const id = scheduler.scheduled[0]!.deliveryId;
      const delays: number[] = [];
      for (let i = 0; i < 8; i++) {
        await deliverOnce(deps, id);
        const last = scheduler.scheduled[scheduler.scheduled.length - 1]!;
        if (last.deliveryId === id && scheduler.scheduled.length === i + 2) delays.push(last.delaySeconds);
      }
      expect(delays).toEqual([30, 120, 600, 1800, 3600, 10800, 21600, 43200].slice(0, 7));
      const dl = (await request(app).get(`/v1/webhooks/${ep.id}/deliveries`).set(h)).body.data[0];
      expect(dl).toMatchObject({ status: "dead", attempt: 8, response_status: 500 });
      expect(rx.got).toHaveLength(8);
      const retry = await request(app).post(`/v1/webhooks/${ep.id}/deliveries/${id}/retry`).set(h).send({});
      expect(retry.status).toBe(202);
      expect(scheduler.scheduled[scheduler.scheduled.length - 1]).toEqual({ deliveryId: id, delaySeconds: 0 });
    } finally { rx.close(); }
  });

  it("caps endpoints at five, requires https, and disables after fifty consecutive failures", async () => {
    const { app, deps } = await makeTestApp();
    const k = await mintKey(app);
    const h = bearer(k.secret);
    expect((await request(app).post("/v1/webhooks").set(h).send({ url: "http://example.com/x", events: ["*"] })).status).toBe(422);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await request(app).post("/v1/webhooks").set(h).send({ url: `https://example.com/${i}`, events: ["*"] })).body.id);
    expect((await request(app).post("/v1/webhooks").set(h).send({ url: "https://example.com/6", events: ["*"] })).body.code).toBe("sandbox_limit_reached");
    await deps.pool.query("update webhook_endpoints set consecutive_failures = 50, status = 'disabled' where id = $1", [ids[0]]);
    const me = await request(app).get("/v1/keys/me").set(h);
    expect(me.headers["plutus-warning"]).toContain(ids[0]);
    const patched = await request(app).patch(`/v1/webhooks/${ids[0]}`).set(h).send({ status: "active" });
    expect(patched.body).toMatchObject({ status: "active", consecutive_failures: 0 });
    expect((await request(app).delete(`/v1/webhooks/${ids[1]}`).set(h)).status).toBe(204);
  });
});
