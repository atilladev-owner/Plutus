import { describe, it, expect } from "vitest";
import { testPool } from "../helpers/db.js";
import { withSnapshotTx } from "../../src/db/pool.js";

describe("withSnapshotTx", () => {
  it("sets repeatable read as the transaction's first statement, before the caller's own reads", async () => {
    const level = await withSnapshotTx(testPool(), async (c) => {
      const { rows } = await c.query<{ level: string }>("select current_setting('transaction_isolation') as level");
      return rows[0]!.level;
    });
    expect(level).toBe("repeatable read");
  });
});
