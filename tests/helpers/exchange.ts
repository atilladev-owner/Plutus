import { testPool } from "./db.js";
import * as L from "../../src/db/ledger.js";
import { verifyChain, type VerifyReport } from "../../src/domain/verify.js";
import { EXCHANGE_LEDGER_ID } from "../../src/db/exchange.js";

/**
 * Verifies ldg_exchange's hash chain, gapless sequence and full balance replay: the check
 * every exchange test file needs after any scenario that touches money. Used to be
 * duplicated three times (matching.test.ts, exchange-wallet.test.ts,
 * exchange-schema.test.ts), each reading the account balances on one connection and then
 * the journal, a page at a time, on a fresh connection and transaction per page through
 * withTx. Every one of those reads ran under plain read committed, so a transfer committed
 * by a different test file mid read, this database is shared across every exchange test
 * file that runs concurrently, could land after the balance snapshot but before (or half
 * way through) the journal pages, tearing the two apart: the balances would reflect it, the
 * journal replay would not yet, and the comparison would fail for a reason that has nothing
 * to do with whatever this test file itself was checking.
 *
 * This version opens one connection, starts one transaction at repeatable read, and reads
 * both the balances and every journal page on it. Repeatable read pins the whole
 * transaction to a single snapshot taken at its first statement, so every statement here
 * sees the exact same instant of the database, however many other transactions commit
 * against ldg_exchange while this one is still running.
 */
export async function verifyExchangeLedger(): Promise<VerifyReport> {
  const client = await testPool().connect();
  try {
    await client.query("begin");
    await client.query("set transaction isolation level repeatable read");
    const { rows: accountRows } = await client.query<{ id: string; balance: string; held: string }>(
      "select id, balance::text as balance, held::text as held from accounts where ledger_id = $1", [EXCHANGE_LEDGER_ID]);
    const stored = new Map(accountRows.map((r) => [r.id, { balance: BigInt(r.balance), held: BigInt(r.held) }]));
    async function* entries() {
      let since = 0n;
      for (;;) {
        const batch = await L.listJournal(client, EXCHANGE_LEDGER_ID, since, 1000);
        if (batch.length === 0) return;
        for (const row of batch) yield row;
        since = BigInt(batch[batch.length - 1]!.seq);
      }
    }
    const report = await verifyChain(entries(), stored);
    await client.query("commit");
    return report;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
