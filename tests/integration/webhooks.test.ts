import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type dns from "node:dns";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import { verifySignature } from "../../src/platform/webhook-sign.js";
import { deliverOnce } from "../../src/platform/deliver.js";
import { MemoryScheduler } from "../../src/platform/scheduler.js";

/** A fake dns.promises.lookup that never settles: only its call shape (hostname,
 * options) matters here, so the assignment goes through an unknown cast rather than
 * shaping this to satisfy every real overload. */
function neverSettlingLookup(): typeof dns.promises.lookup {
  return (() => new Promise<never>(() => { /* never settles */ })) as unknown as typeof dns.promises.lookup;
}

function fixedLookup(addresses: Array<{ address: string; family: number }>): typeof dns.promises.lookup {
  return (async () => addresses) as unknown as typeof dns.promises.lookup;
}

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

/** A receiver that answers 200 with a body far bigger than the 1024 byte excerpt cap. */
function bigBodyReceiver(bytes: number): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => { res.statusCode = 200; res.end("x".repeat(bytes)); });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/hook`, close: () => server.close() });
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
      // Registration requires a public https host, and the local receiver lives on
      // 127.0.0.1 (loopback, refused by assertPublicWebhookUrl); register a public
      // looking url instead and flip it to the real local receiver by direct SQL.
      const ep = await request(app).post("/v1/webhooks").set(h).send({ url: "https://example.com/hook", events: ["transfer.posted"] });
      expect(ep.status).toBe(201);
      expect(ep.body.secret).toMatch(/^whsec_/);
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

  it("refuses webhook urls that are not public https hosts", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const bad = [
      "https://169.254.169.254/x",
      "https://localhost/x",
      "https://10.0.0.1/x",
      "https://[::1]/x",
      "https://foo.internal/x",
      "https://user:pw@example.com/x",
    ];
    for (const url of bad) {
      const res = await request(app).post("/v1/webhooks").set(h).send({ url, events: ["*"] });
      expect(res.status).toBe(422);
    }
    const ok = await request(app).post("/v1/webhooks").set(h).send({ url: "https://example.com/x", events: ["*"] });
    expect(ok.status).toBe(201);
  });

  it("caps the stored response excerpt at 1024 bytes even when the endpoint sends far more", async () => {
    const { app, deps } = await makeTestApp();
    const scheduler = new MemoryScheduler();
    deps.scheduler = scheduler;
    const rx = await bigBodyReceiver(100_000);
    try {
      const k = await mintKey(app);
      const h = bearer(k.secret);
      const ep = (await request(app).post("/v1/webhooks").set(h).send({ url: "https://example.com/x", events: ["*"] })).body;
      await deps.pool.query("update webhook_endpoints set url = $2 where id = $1", [ep.id, rx.url]);
      const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "w" })).body;
      const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "a" })).body;
      await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:GHS", to: a.id, asset: "GHS", amount: "100" }] });
      const id = scheduler.scheduled[0]!.deliveryId;
      await deliverOnce(deps, id);
      const dl = (await request(app).get(`/v1/webhooks/${ep.id}/deliveries`).set(h)).body.data[0];
      expect(dl.status).toBe("succeeded");
      expect(Buffer.byteLength(dl.response_excerpt as string, "utf8")).toBeLessThanOrEqual(1024);
    } finally { rx.close(); }
  });

  it("locks a delivery so two concurrent attempts only ever reach the endpoint once", async () => {
    const { app, deps } = await makeTestApp();
    const scheduler = new MemoryScheduler();
    deps.scheduler = scheduler;
    let hits = 0;
    const rx = await receiver(() => { hits += 1; return 200; });
    try {
      const k = await mintKey(app);
      const h = bearer(k.secret);
      const ep = (await request(app).post("/v1/webhooks").set(h).send({ url: "https://example.com/x", events: ["*"] })).body;
      await deps.pool.query("update webhook_endpoints set url = $2 where id = $1", [ep.id, rx.url]);
      const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "w" })).body;
      const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "a" })).body;
      await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:GHS", to: a.id, asset: "GHS", amount: "100" }] });
      const id = scheduler.scheduled[0]!.deliveryId;
      await Promise.all([deliverOnce(deps, id), deliverOnce(deps, id)]);
      expect(hits).toBe(1);
      const dl = (await request(app).get(`/v1/webhooks/${ep.id}/deliveries`).set(h)).body.data[0];
      expect(dl).toMatchObject({ status: "succeeded", attempt: 1 });
    } finally { rx.close(); }
  });

  it("bounds a hanging resolver instead of holding the delivery's connection open", async () => {
    const { app, deps } = await makeTestApp();
    const scheduler = new MemoryScheduler();
    deps.scheduler = scheduler;
    const rx = await receiver(() => 200);
    try {
      const k = await mintKey(app);
      const h = bearer(k.secret);
      const ep = (await request(app).post("/v1/webhooks").set(h).send({ url: "https://example.com/x", events: ["*"] })).body;
      await deps.pool.query("update webhook_endpoints set url = $2 where id = $1", [ep.id, rx.url]);
      const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "w" })).body;
      const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "a" })).body;
      await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:GHS", to: a.id, asset: "GHS", amount: "100" }] });
      const id = scheduler.scheduled[0]!.deliveryId;
      const started = Date.now();
      await deliverOnce(deps, id, { lookup: neverSettlingLookup() });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(rx.got).toHaveLength(0);
      const dl = (await request(app).get(`/v1/webhooks/${ep.id}/deliveries`).set(h)).body.data[0];
      expect(["failed", "pending"]).toContain(dl.status);
      expect(dl.response_status).toBeNull();
      expect(dl.response_excerpt).toBe("destination lookup failed");
    } finally { rx.close(); }
  }, 15_000);

  it("refuses an attempt whose resolved address is private, even though the url passed registration", async () => {
    const { app, deps } = await makeTestApp();
    const scheduler = new MemoryScheduler();
    deps.scheduler = scheduler;
    const rx = await receiver(() => 200);
    try {
      const k = await mintKey(app);
      const h = bearer(k.secret);
      const ep = (await request(app).post("/v1/webhooks").set(h).send({ url: "https://example.com/x", events: ["*"] })).body;
      await deps.pool.query("update webhook_endpoints set url = $2 where id = $1", [ep.id, rx.url]);
      const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "w" })).body;
      const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "a" })).body;
      await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:GHS", to: a.id, asset: "GHS", amount: "100" }] });
      const id = scheduler.scheduled[0]!.deliveryId;
      await deliverOnce(deps, id, { lookup: fixedLookup([{ address: "10.0.0.1", family: 4 }]) });
      expect(rx.got).toHaveLength(0);
      const dl = (await request(app).get(`/v1/webhooks/${ep.id}/deliveries`).set(h)).body.data[0];
      expect(["failed", "pending"]).toContain(dl.status);
      expect(dl.response_status).toBeNull();
      expect(dl.response_excerpt).toBe("destination resolves to a private address");
    } finally { rx.close(); }
  });

  it("judges the resolved address, not the url: a public answer is let through to the real receiver", async () => {
    const { app, deps } = await makeTestApp();
    const scheduler = new MemoryScheduler();
    deps.scheduler = scheduler;
    const rx = await receiver(() => 200);
    try {
      const k = await mintKey(app);
      const h = bearer(k.secret);
      const ep = (await request(app).post("/v1/webhooks").set(h).send({ url: "https://example.com/x", events: ["*"] })).body;
      // The url still points at the local receiver (127.0.0.1, which isPublicAddress
      // would refuse); the injected resolver answers with a public address instead, and
      // that answer, not the url's own host, is what the check judges.
      await deps.pool.query("update webhook_endpoints set url = $2 where id = $1", [ep.id, rx.url]);
      const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "w" })).body;
      const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "a" })).body;
      await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:GHS", to: a.id, asset: "GHS", amount: "100" }] });
      const id = scheduler.scheduled[0]!.deliveryId;
      await deliverOnce(deps, id, { lookup: fixedLookup([{ address: "93.184.216.34", family: 4 }]) });
      expect(rx.got).toHaveLength(1);
      const dl = (await request(app).get(`/v1/webhooks/${ep.id}/deliveries`).set(h)).body.data[0];
      expect(dl).toMatchObject({ status: "succeeded", attempt: 1, response_status: 200 });
    } finally { rx.close(); }
  });
});
