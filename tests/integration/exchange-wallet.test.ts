import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey } from "../helpers/keys.js";
import { testPool } from "../helpers/db.js";
import { withTx } from "../../src/db/pool.js";
import { newId } from "../../src/domain/ids.js";
import { signRequest } from "../../src/platform/signing.js";
import { generateSecret } from "../../src/platform/auth.js";
import { insertKey } from "../../src/db/keys.js";
import * as L from "../../src/db/ledger.js";
import { resetExchangeBooks, verifyExchangeLedger } from "../helpers/exchange.js";
import { EXCHANGE_LEDGER_ID } from "../../src/db/exchange.js";

// 100,000 USDT (exponent 6), 1 BTC and 10 ETH (exponent 8 each) in minor units, spec 10.2.
const FAUCET_USDT = "100000000000";
const FAUCET_BTC = "100000000";
const FAUCET_ETH = "1000000000";

function sign(keyId: string, secret: string, method: string, path: string): Record<string, string> {
  return signRequest({ keyId, secret, method, path, timestamp: Date.now() });
}

async function faucet(app: Parameters<typeof request>[0], k: { id: string; secret: string }, extraHeaders: Record<string, string> = {}) {
  return request(app).post("/v1/exchange/faucet").set({ ...sign(k.id, k.secret, "POST", "/v1/exchange/faucet"), ...extraHeaders }).send();
}

async function reset(app: Parameters<typeof request>[0], k: { id: string; secret: string }) {
  return request(app).post("/v1/exchange/reset").set(sign(k.id, k.secret, "POST", "/v1/exchange/reset")).send();
}

async function balances(app: Parameters<typeof request>[0], k: { id: string; secret: string }) {
  return request(app).get("/v1/exchange/balances").set(sign(k.id, k.secret, "GET", "/v1/exchange/balances"));
}

async function liveKey(): Promise<{ id: string; secret: string }> {
  const s = generateSecret("live");
  const row = await withTx(testPool(), (c) => insertKey(c, {
    id: newId("key"), secretHash: s.hash, prefix: s.prefix, last4: s.last4, mode: "live", scopes: ["exchange:trade"],
  }));
  return { id: row.id, secret: s.secret };
}

interface ExchangeAccount { id: string; asset: string; balance: string; held: string }

async function accountsOf(keyId: string): Promise<ExchangeAccount[]> {
  const { rows } = await testPool().query<ExchangeAccount>(
    "select id, asset, balance::text as balance, held::text as held from accounts where ledger_id = $1 and name = $2 and kind = 'normal' order by asset",
    [EXCHANGE_LEDGER_ID, keyId]);
  return rows;
}

describe("exchange wallets", () => {
  // Cross file contamination: matching.test.ts, exchange-orders.test.ts, house.test.ts,
  // market-data.test.ts and sweep.test.ts all trade the same shared BTC-USDT and
  // ETH-USDT books this file's own reset and faucet scenarios touch.
  beforeAll(async () => {
    await resetExchangeBooks();
  });

  it("lists no balances before the first faucet call", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const res = await balances(app, k);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });

  it("funds a fresh key with exactly the seeded amounts on the first faucet call", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const res = await faucet(app, k);
    expect(res.status).toBe(200);
    const byAsset = new Map(res.body.data.map((r: { asset: string }) => [r.asset, r]));
    expect(byAsset.get("USDT")).toMatchObject({ balance: FAUCET_USDT, held: "0", available: FAUCET_USDT });
    expect(byAsset.get("BTC")).toMatchObject({ balance: FAUCET_BTC, held: "0", available: FAUCET_BTC });
    expect(byAsset.get("ETH")).toMatchObject({ balance: FAUCET_ETH, held: "0", available: FAUCET_ETH });
    const read = await balances(app, k);
    expect(read.body.data).toHaveLength(3);
  });

  it("refuses a second faucet inside 24 hours with a cooldown and a Retry-After header, balances unchanged", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    await faucet(app, k);
    const again = await faucet(app, k);
    expect(again.status).toBe(429);
    expect(again.body.code).toBe("faucet_cooldown");
    const retryAfter = Number(again.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(86400);
    const rows = await accountsOf(k.id);
    expect(rows.find((r) => r.asset === "USDT")?.balance).toBe(FAUCET_USDT);
  });

  it("funds again once the 24 hour cooldown has actually passed", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    await faucet(app, k);
    await testPool().query("update faucets set last_at = now() - interval '25 hours' where key_id = $1", [k.id]);
    const res = await faucet(app, k);
    expect(res.status).toBe(200);
    const rows = await accountsOf(k.id);
    expect(rows.find((r) => r.asset === "USDT")?.balance).toBe((BigInt(FAUCET_USDT) * 2n).toString());
    expect(rows.find((r) => r.asset === "BTC")?.balance).toBe((BigInt(FAUCET_BTC) * 2n).toString());
  });

  it("replays the stored reply for a repeated Idempotency-Key instead of funding twice", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const first = await faucet(app, k, { "Idempotency-Key": "f-1" });
    expect(first.status).toBe(200);
    const second = await faucet(app, k, { "Idempotency-Key": "f-1" });
    expect(second.status).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    const rows = await accountsOf(k.id);
    expect(rows.find((r) => r.asset === "USDT")?.balance).toBe(FAUCET_USDT);
  });

  it("keeps balances isolated per key", async () => {
    const { app } = await makeTestApp();
    const a = await mintKey(app);
    const b = await mintKey(app);
    await faucet(app, a);
    const bBalances = await balances(app, b);
    expect(bBalances.body).toEqual({ data: [] });
  });

  it("resets balances back to the faucet amounts and releases open holds after trading activity, keeping the chain valid", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    await faucet(app, k);
    // accountsOf orders by asset ascending: BTC, ETH, USDT.
    const [btc, eth, usdt] = await accountsOf(k.id);

    // Stand in for a completed trade, since order placement is Task 5: the trader spent
    // 50,000 USDT and received 1 more BTC, and has 0.5 ETH on an open hold, as though an
    // order were resting on the book.
    let holdId = "";
    await withTx(testPool(), async (c) => {
      await L.postTransfer(c, {
        ledgerId: EXCHANGE_LEDGER_ID, transferId: newId("tr"),
        legs: [
          { from: usdt!.id, to: "world:USDT", asset: "USDT", amount: "50000000000" },
          { from: "world:BTC", to: btc!.id, asset: "BTC", amount: "100000000" },
        ],
        memo: "stand in for a completed trade", metadata: {},
      });
      const hold = await L.createHold(c, {
        ledgerId: EXCHANGE_LEDGER_ID, holdId: newId("hold"), accountId: eth!.id, amount: "50000000",
        expiresAt: new Date(Date.now() + 900_000), memo: "stand in for a resting order", metadata: {},
      });
      holdId = hold.id;
    });

    const before = await accountsOf(k.id);
    expect(before.find((r) => r.asset === "USDT")?.balance).toBe("50000000000");
    expect(before.find((r) => r.asset === "BTC")?.balance).toBe((BigInt(FAUCET_BTC) * 2n).toString());
    expect(before.find((r) => r.asset === "ETH")?.held).toBe("50000000");

    const res = await reset(app, k);
    expect(res.status).toBe(200);

    const after = await accountsOf(k.id);
    expect(after.find((r) => r.asset === "USDT")).toMatchObject({ balance: FAUCET_USDT, held: "0" });
    expect(after.find((r) => r.asset === "BTC")).toMatchObject({ balance: FAUCET_BTC, held: "0" });
    expect(after.find((r) => r.asset === "ETH")).toMatchObject({ balance: FAUCET_ETH, held: "0" });

    const { rows: holdRows } = await testPool().query<{ status: string }>("select status from holds where id = $1", [holdId]);
    expect(holdRows[0]?.status).toBe("released");

    const report = await verifyExchangeLedger();
    expect(report).toMatchObject({ ok: true, chain_ok: true, sequence_ok: true, replay_matches: true });
  });

  it("does nothing on reset for a key that never called the faucet", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const res = await reset(app, k);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });

  it("refuses the faucet and the reset for a live mode key", async () => {
    const { app } = await makeTestApp();
    const live = await liveKey();
    const faucetRes = await faucet(app, live);
    expect(faucetRes.status).toBe(403);
    expect(faucetRes.body.code).toBe("sandbox_only");
    const resetRes = await reset(app, live);
    expect(resetRes.status).toBe(403);
    expect(resetRes.body.code).toBe("sandbox_only");
  });

  // Review round 1, finding 5: lock_markets takes any text and hashes it (hashtext(symbol))
  // the same way regardless of whether it names a real market, so this proves the same
  // acquire-hold-release behaviour with two private nonce strings nothing else in a
  // concurrently running test file could ever also be locking. Locking the real
  // "BTC-USDT" here, as this test used to, meant its final assertion (nobody else holds the
  // lock right now) could false fail the instant any other file's own order placement or
  // cancellation held that exact global, unscoped lock at the same moment.
  it("locks every market in symbol order before touching anything else, so the same order holds for later matching", async () => {
    const symbols = [newId("evt"), newId("evt")].sort();
    const holder = await testPool().connect();
    try {
      await holder.query("begin");
      await holder.query("select lock_markets($1::text[])", [symbols]);
      const contender = await testPool().connect();
      try {
        const { rows } = await contender.query<{ locked: boolean }>(
          "select not pg_try_advisory_xact_lock(hashtext($1)) as locked", [symbols[0]]);
        expect(rows[0]?.locked).toBe(true);
      } finally {
        contender.release();
      }
      await holder.query("commit");
    } finally {
      holder.release();
    }
    const after = await testPool().connect();
    try {
      const { rows } = await after.query<{ locked: boolean }>(
        "select pg_try_advisory_xact_lock(hashtext($1)) as locked", [symbols[0]]);
      expect(rows[0]?.locked).toBe(true);
      await after.query("select pg_advisory_unlock_all()");
    } finally {
      after.release();
    }
  });
});
