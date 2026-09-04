import pg from "pg";

const { Pool, types } = pg;
// int8 arrives as a string, never a number. BIGINT never touches a float.
types.setTypeParser(20, (v: string) => v);

export type { Pool, PoolClient } from "pg";

export function createPool(connectionString: string): pg.Pool {
  return new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 25_000,
  });
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
