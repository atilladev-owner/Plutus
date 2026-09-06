import pg from "pg";

const { Pool, types } = pg;
// int8 arrives as a string, never a number. BIGINT never touches a float.
types.setTypeParser(20, (v: string) => v);

export type { Pool, PoolClient } from "pg";

export function createPool(connectionString: string, onIdleError?: (err: Error) => void): pg.Pool {
  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 25_000,
  });
  // pg emits error on the pool when an idle client drops, which a hosted database does
  // whenever it closes a quiet connection. Without a listener Node treats that as an
  // uncaught exception and the process dies. The pool discards the client on its own.
  pool.on("error", (err) => {
    if (onIdleError) onIdleError(err);
  });
  return pool;
}

export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    try { await client.query("rollback"); } catch { /* the connection is already broken */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Like withTx, but the transaction is pinned to one snapshot, taken at its first statement,
 * for the whole of fn: "set transaction isolation level repeatable read" runs immediately
 * after "begin", before fn's own first read. Plain read committed (withTx) lets each
 * statement inside the same transaction see whatever has committed by the time it runs,
 * which is wrong for a caller that reads more than one thing and needs them to agree with
 * each other, not just each be individually up to date: src/routes/verify.ts's
 * verifyLedgerReport reads every account's stored balance and then walks the whole journal
 * to replay it, and a transfer committed in between would move the accounts read but not
 * yet the journal pages this same call is about to read, failing replay_matches for a
 * ledger that is actually perfectly healthy. tests/integration/pool.test.ts asserts the
 * isolation level from inside the transaction rather than trying to race two real
 * concurrent writers deterministically.
 */
export async function withSnapshotTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set transaction isolation level repeatable read");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    try { await client.query("rollback"); } catch { /* the connection is already broken */ }
    throw err;
  } finally {
    client.release();
  }
}
