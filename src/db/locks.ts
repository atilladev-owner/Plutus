import type { PoolClient } from "pg";

/**
 * The row locks the sandbox ceilings take before counting anything.
 *
 * Security sweep, finding 4: ledgers per key (10, src/routes/ledgers.ts), accounts per
 * ledger (50, src/routes/accounts.ts) and webhook endpoints per key (5,
 * src/routes/webhooks.ts) were each a select count(*) followed by an insert. Both statements
 * ran in one transaction, but nothing was locked in between, and a count is not a lock: two
 * concurrent requests for the same key both read the same count, both saw room, and both
 * inserted. A caller sending its creates at once could exceed any of the three ceilings by
 * as many requests as it sent.
 *
 * Locking the row that owns the ceiling, before the count, is what serialises them: the
 * second transaction blocks on the lock until the first commits, then counts the row the
 * first actually inserted. The lock is held to the end of the caller's transaction, which is
 * the same transaction the insert commits in, so there is no window between the check and
 * the write. ownLedger (src/routes/ledgers.ts) reads its ledger with a plain select and
 * takes no lock of its own, so the accounts ceiling needs lockLedger here rather than
 * relying on that read.
 *
 * Both are taken only when the ceiling actually applies, which is only for a sandbox key: a
 * live key has no ceiling to enforce, and serialising its inserts behind a row lock would
 * cost it concurrency for a check that can never fire.
 *
 * Neither can be half of a deadlock cycle, and the reason is not that nothing else locks
 * these two tables in the other order: the daily sweep's deleteIdleSandbox (src/db/ledger.ts)
 * does exactly that, deleting ledgers rows and then api_keys rows inside one transaction. The
 * reason is that a transaction that holds one lock and then waits on nothing anyone else
 * holds cannot close a cycle. Each ceiling path takes exactly one of these rows and then
 * touches only rows it is creating: the count reads its own key's or ledger's children
 * without locking them, and the insert takes a lock on the new row alone, plus the key share
 * on the parent this transaction already holds for update. So both paths are terminal in the
 * wait graph. A concurrent sweep can block behind one of them, and does; it can never be
 * blocked by one that is itself blocked waiting on the sweep.
 */
export async function lockKey(c: PoolClient, keyId: string): Promise<void> {
  await c.query("select 1 from api_keys where id = $1 for update", [keyId]);
}

export async function lockLedger(c: PoolClient, ledgerId: string): Promise<void> {
  await c.query("select 1 from ledgers where id = $1 for update", [ledgerId]);
}
