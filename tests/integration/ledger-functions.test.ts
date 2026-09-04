import { describe, it, expect, beforeAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { testPool } from "../helpers/db.js";
import { withTx } from "../../src/db/pool.js";
import { newId } from "../../src/domain/ids.js";
import { canonicalJson, hashEntry, GENESIS_HASH, type JsonValue } from "../../src/domain/canonical.js";
import { mapDbError } from "../../src/db/errors.js";
import * as L from "../../src/db/ledger.js";

async function seedKey(mode: "test" | "live" = "test"): Promise<string> {
  const id = newId("key");
  const hash = createHash("sha256").update(randomBytes(32)).digest();
  await testPool().query(
    "insert into api_keys (id, secret_hash, prefix, last4, mode, scopes) values ($1, $2, 'pl_test', 'abcd', $3, '{ledger:read,ledger:write}')",
    [id, hash, mode]);
  return id;
}

async function seedLedger(): Promise<{ keyId: string; ledgerId: string; a: string; b: string }> {
  const keyId = await seedKey();
  return withTx(testPool(), async (c) => {
    const ledger = await L.createLedger(c, { id: newId("ldg"), keyId, name: "t" });
    const a = await L.createAccount(c, { id: newId("acct"), ledgerId: ledger.id, asset: "GHS", name: "a", metadata: {} });
    const b = await L.createAccount(c, { id: newId("acct"), ledgerId: ledger.id, asset: "GHS", name: "b", metadata: {} });
    return { keyId, ledgerId: ledger.id, a: a.id, b: b.id };
  });
}

async function balances(ledgerId: string): Promise<Array<{ id: string; kind: string; balance: string; held: string }>> {
  const { rows } = await testPool().query("select id, kind, balance::text, held::text from accounts where ledger_id = $1 order by id", [ledgerId]);
  return rows;
}

describe("post_transfer", () => {
  let s: Awaited<ReturnType<typeof seedLedger>>;
  beforeAll(async () => { s = await seedLedger(); });

  it("funds an account from the world and the ledger sums to zero", async () => {
    const r = await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: "world:GHS", to: s.a, asset: "GHS", amount: "1000" }], memo: "fund", metadata: {} }));
    expect(r.seq).toBe("1");
    expect(r.event_ids).toHaveLength(1);
    const rows = await balances(s.ledgerId);
    const sum = rows.reduce((acc, r) => acc + BigInt(r.balance), 0n);
    expect(sum).toBe(0n);
    expect(rows.find((r) => r.kind === "world")?.balance).toBe("-1000");
  });

  it("moves money between accounts and refuses an overdraft", async () => {
    await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: s.a, to: s.b, asset: "GHS", amount: "400" }], memo: "", metadata: {} }));
    const err = await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: s.a, to: s.b, asset: "GHS", amount: "601" }], memo: "", metadata: {} })).catch((e: unknown) => e);
    const mapped = mapDbError(err);
    expect(mapped?.code).toBe("insufficient_funds");
    expect(mapped?.status).toBe(409);
    expect(mapped?.message).toContain("available 600");
  });

  it("applies several legs atomically or not at all", async () => {
    const before = await balances(s.ledgerId);
    const err = await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [
      { from: s.a, to: s.b, asset: "GHS", amount: "100" },
      { from: s.b, to: s.a, asset: "GHS", amount: "999999" },
    ], memo: "", metadata: {} })).catch((e: unknown) => e);
    expect(mapDbError(err)?.code).toBe("insufficient_funds");
    expect(await balances(s.ledgerId)).toEqual(before);
  });

  it("refuses a leg whose account holds a different asset", async () => {
    const usd = await withTx(testPool(), (c) => L.createAccount(c, { id: newId("acct"), ledgerId: s.ledgerId, asset: "USD", name: "usd", metadata: {} }));
    const err = await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: s.a, to: usd.id, asset: "GHS", amount: "1" }], memo: "", metadata: {} })).catch((e: unknown) => e);
    expect(mapDbError(err)?.code).toBe("asset_mismatch");
  });

  it("refuses more than twenty legs, a self transfer, and a foreign account", async () => {
    const many = Array.from({ length: 21 }, () => ({ from: s.a, to: s.b, asset: "GHS", amount: "1" }));
    expect(mapDbError(await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: many, memo: "", metadata: {} })).catch((e: unknown) => e))?.code).toBe("validation_failed");
    expect(mapDbError(await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: s.a, to: s.a, asset: "GHS", amount: "1" }], memo: "", metadata: {} })).catch((e: unknown) => e))?.code).toBe("validation_failed");
    const other = await seedLedger();
    expect(mapDbError(await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: other.a, to: s.b, asset: "GHS", amount: "1" }], memo: "", metadata: {} })).catch((e: unknown) => e))?.code).toBe("not_found");
  });

  it("writes a journal whose hashes the TypeScript side can recompute", async () => {
    const rows = await withTx(testPool(), (c) => L.listJournal(c, s.ledgerId, 0n, 100));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    let prev = GENESIS_HASH;
    for (const [i, row] of rows.entries()) {
      expect(row.seq).toBe(String(i + 1));
      expect(row.prev_hash.equals(prev)).toBe(true);
      const recomputed = hashEntry(prev, canonicalJson(row.payload as JsonValue));
      expect(recomputed.equals(row.hash)).toBe(true);
      prev = row.hash;
    }
    const { rows: led } = await testPool().query<{ head_hash: Buffer }>("select head_hash from ledgers where id = $1", [s.ledgerId]);
    expect(led[0]?.head_hash.equals(prev)).toBe(true);
  });
});

describe("holds", () => {
  it("reserves, captures partly, keeps the rest held, then releases", async () => {
    const s = await seedLedger();
    await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: "world:GHS", to: s.a, asset: "GHS", amount: "1000" }], memo: "", metadata: {} }));
    const holdId = newId("hold");
    await withTx(testPool(), (c) => L.createHold(c, { ledgerId: s.ledgerId, holdId, accountId: s.a, amount: "600", expiresAt: new Date(Date.now() + 60_000), memo: "", metadata: {} }));
    let a = (await balances(s.ledgerId)).find((r) => r.id === s.a);
    expect(a?.held).toBe("600");
    // Only 400 is available now.
    expect(mapDbError(await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: s.a, to: s.b, asset: "GHS", amount: "401" }], memo: "", metadata: {} })).catch((e: unknown) => e))?.code).toBe("insufficient_funds");
    // Capture 250 from the hold.
    await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from_hold: holdId, to: s.b, asset: "GHS", amount: "250" }], memo: "", metadata: {} }));
    a = (await balances(s.ledgerId)).find((r) => r.id === s.a);
    expect(a?.balance).toBe("750");
    expect(a?.held).toBe("350");
    const hold = await withTx(testPool(), (c) => L.getHold(c, s.ledgerId, holdId));
    expect(hold?.status).toBe("open");
    expect(hold?.remaining).toBe("350");
    // Release the rest.
    const rel = await withTx(testPool(), (c) => L.releaseHold(c, s.ledgerId, holdId, "hold.released"));
    expect(rel.released).toBe("350");
    a = (await balances(s.ledgerId)).find((r) => r.id === s.a);
    expect(a?.held).toBe("0");
    expect(mapDbError(await withTx(testPool(), (c) => L.releaseHold(c, s.ledgerId, holdId, "hold.released")).catch((e: unknown) => e))?.code).toBe("hold_not_open");
  });

  it("closes as captured when fully drawn, and expires on request", async () => {
    const s = await seedLedger();
    await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: "world:GHS", to: s.a, asset: "GHS", amount: "100" }], memo: "", metadata: {} }));
    const h1 = newId("hold");
    await withTx(testPool(), (c) => L.createHold(c, { ledgerId: s.ledgerId, holdId: h1, accountId: s.a, amount: "40", expiresAt: new Date(Date.now() + 60_000), memo: "", metadata: {} }));
    const r = await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from_hold: h1, to: s.b, asset: "GHS", amount: "40" }], memo: "", metadata: {} }));
    expect(r.event_ids).toHaveLength(2); // transfer.posted and hold.captured
    expect((await withTx(testPool(), (c) => L.getHold(c, s.ledgerId, h1)))?.status).toBe("captured");
    const h2 = newId("hold");
    await withTx(testPool(), (c) => L.createHold(c, { ledgerId: s.ledgerId, holdId: h2, accountId: s.a, amount: "10", expiresAt: new Date(Date.now() - 1000), memo: "", metadata: {} }));
    expect(await withTx(testPool(), (c) => L.expireHolds(c, s.ledgerId, null))).toBe(1);
    expect((await withTx(testPool(), (c) => L.getHold(c, s.ledgerId, h2)))?.status).toBe("expired");
    expect((await balances(s.ledgerId)).find((x) => x.id === s.a)?.held).toBe("0");
  });

  it("refuses holds on world accounts and beyond available", async () => {
    const s = await seedLedger();
    const { rows } = await testPool().query<{ id: string }>("select resolve_account($1, 'world:GHS', 'GHS', now()) as id", [s.ledgerId]);
    const world = rows[0]?.id as string;
    expect(mapDbError(await withTx(testPool(), (c) => L.createHold(c, { ledgerId: s.ledgerId, holdId: newId("hold"), accountId: world, amount: "1", expiresAt: new Date(), memo: "", metadata: {} })).catch((e: unknown) => e))?.code).toBe("validation_failed");
    expect(mapDbError(await withTx(testPool(), (c) => L.createHold(c, { ledgerId: s.ledgerId, holdId: newId("hold"), accountId: s.a, amount: "1", expiresAt: new Date(), memo: "", metadata: {} })).catch((e: unknown) => e))?.code).toBe("insufficient_funds");
  });
});
