import { createPool, type Pool } from "../../src/db/pool.js";

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set; the global setup did not run");
  return url;
}

let shared: Pool | undefined;
export function testPool(): Pool {
  shared ??= createPool(testDatabaseUrl());
  return shared;
}

/** Ends the shared pool so a worker that runs many files does not accumulate connections. */
export async function closeTestPool(): Promise<void> {
  const p = shared;
  shared = undefined;
  if (p) await p.end();
}
