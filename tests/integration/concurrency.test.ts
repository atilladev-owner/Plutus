import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { testPool } from "../helpers/db.js";
import { withTx } from "../../src/db/pool.js";
import { newId } from "../../src/domain/ids.js";
import * as L from "../../src/db/ledger.js";
import { mapDbError } from "../../src/db/errors.js";

describe("two people, one balance", () => {
  it("fifty parallel transfers with money for twenty: exactly twenty post, no gap, never negative", async () => {
    const keyId = newId("key");
    await testPool().query("insert into api_keys (id, secret_hash, prefix, last4, mode, scopes) values ($1, $2, 'pl_test', 'abcd', 'test', '{ledger:write}')",
      [keyId, createHash("sha256").update(randomBytes(32)).digest()]);
    const { ledgerId, a, b } = await withTx(testPool(), async (c) => {
      const l = await L.createLedger(c, { id: newId("ldg"), keyId, name: "race" });
      const a = await L.createAccount(c, { id: newId("acct"), ledgerId: l.id, asset: "USD", name: "a", metadata: {} });
      const b = await L.createAccount(c, { id: newId("acct"), ledgerId: l.id, asset: "USD", name: "b", metadata: {} });
      await L.postTransfer(c, { ledgerId: l.id, transferId: newId("tr"), legs: [{ from: "world:USD", to: a.id, asset: "USD", amount: "2000" }], memo: "", metadata: {} });
      return { ledgerId: l.id, a: a.id, b: b.id };
    });
    // Each transfer is 100. 2000 covers exactly twenty. Fifty race for them on separate connections.
    const results = await Promise.allSettled(Array.from({ length: 50 }, () =>
      withTx(testPool(), (c) => L.postTransfer(c, { ledgerId, transferId: newId("tr"), legs: [{ from: a, to: b, asset: "USD", amount: "100" }], memo: "", metadata: {} }))));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(20);
    // Every loser lost cleanly to the locked, fresh check, not to the schema check
    // constraint catching a race the application check should have caught first.
    for (const r of results) {
      if (r.status === "rejected") expect(mapDbError(r.reason)?.code).toBe("insufficient_funds");
    }
    const { rows } = await testPool().query<{ balance: string; held: string }>("select balance::text, held::text from accounts where id = $1", [a]);
    expect(rows[0]?.balance).toBe("0");
    const journal = await withTx(testPool(), (c) => L.listJournal(c, ledgerId, 0n, 1000));
    expect(journal.map((j) => j.seq)).toEqual(journal.map((_, i) => String(i + 1)));
    expect(journal).toHaveLength(21);
  });
});
