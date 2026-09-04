import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { testPool } from "../helpers/db.js";
import { withTx } from "../../src/db/pool.js";
import { newId } from "../../src/domain/ids.js";
import { decodeCursor, type Cursor } from "../../src/domain/cursor.js";
import * as L from "../../src/db/ledger.js";

describe("pagination", () => {
  it("walks five accounts created in the same transaction without dropping or repeating any", async () => {
    const keyId = newId("key");
    await testPool().query(
      "insert into api_keys (id, secret_hash, prefix, last4, mode, scopes) values ($1, $2, 'pl_test', 'abcd', 'test', '{ledger:write}')",
      [keyId, createHash("sha256").update(randomBytes(32)).digest()]);
    const ledgerId = await withTx(testPool(), async (c) => {
      const l = await L.createLedger(c, { id: newId("ldg"), keyId, name: "page" });
      return l.id;
    });
    // One transaction: all five accounts share the transaction's now(), so they share
    // created_at down to the microsecond.
    await withTx(testPool(), async (c) => {
      for (let i = 0; i < 5; i += 1) {
        await L.createAccount(c, { id: newId("acct"), ledgerId, asset: "GHS", name: `a${i}`, metadata: {} });
      }
    });

    const seen = new Set<string>();
    let cursor: Cursor | null = null;
    let pages = 0;
    let nextCursor: string | null = null;
    for (;;) {
      const page = await withTx(testPool(), (c) => L.listAccounts(c, ledgerId, { limit: 2, cursor }));
      pages += 1;
      for (const row of page.data) seen.add(row.id);
      nextCursor = page.next_cursor;
      if (!nextCursor) break;
      cursor = decodeCursor(nextCursor);
    }
    expect(seen.size).toBe(5);
    expect(pages).toBe(3);
    expect(nextCursor).toBeNull();
  });
});
