import type { PoolClient } from "pg";
import type { Queryable } from "./exchange.js";

export interface KeyRow { id: string; secret_hash: Buffer; prefix: string; last4: string; mode: "test" | "live"; scopes: string[]; created_at: Date; last_used_at: Date | null; expires_at: Date | null; revoked_at: Date | null }

export async function insertKey(c: PoolClient, row: { id: string; secretHash: Buffer; prefix: string; last4: string; mode: "test" | "live"; scopes: string[] }): Promise<KeyRow> {
  const { rows } = await c.query<KeyRow>(
    "insert into api_keys (id, secret_hash, prefix, last4, mode, scopes) values ($1, $2, $3, $4, $5, $6) returning *",
    [row.id, row.secretHash, row.prefix, row.last4, row.mode, row.scopes]);
  return rows[0] as KeyRow;
}

/**
 * The current secret, or a retiring one still inside its grace period. A key's own
 * expires_at is not set by minting or rotation today (idle sandbox keys are removed by a
 * separate sweep, not by a fixed lifetime); the clause below is defence in depth for
 * whichever future feature does set it, so an expired key authenticates with neither its
 * current nor a retiring secret.
 */
export async function findKeyBySecretHash(c: PoolClient, hash: Buffer): Promise<KeyRow | null> {
  const { rows } = await c.query<KeyRow>(
    `select k.*, $1::bytea as secret_hash from api_keys k
     where k.revoked_at is null and (k.expires_at is null or k.expires_at > now()) and (
       k.secret_hash = $1
       or exists (select 1 from api_key_old_secrets o where o.secret_hash = $1 and o.key_id = k.id and o.expires_at > now()))
     limit 1`, [hash]);
  return rows[0] ?? null;
}

export async function getKey(c: PoolClient, id: string): Promise<KeyRow | null> {
  const { rows } = await c.query<KeyRow>("select * from api_keys where id = $1", [id]);
  return rows[0] ?? null;
}

/**
 * The still-unexpired retiring secret hashes for a key, newest rotation first. signedAuth
 * looks a key up by id rather than by hash (there is no hash to look up by until the
 * signature is checked), so it cannot lean on findKeyBySecretHash's single query the way
 * bearerAuth does; it instead tries the current secret_hash first and falls back to these.
 */
export async function listActiveOldSecretHashes(c: PoolClient, keyId: string): Promise<Buffer[]> {
  const { rows } = await c.query<{ secret_hash: Buffer }>(
    "select secret_hash from api_key_old_secrets where key_id = $1 and expires_at > now() order by expires_at desc",
    [keyId]);
  return rows.map((r) => r.secret_hash);
}

export async function touchKey(c: PoolClient, id: string): Promise<void> {
  await c.query("update api_keys set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')", [id]);
}

export async function rotateKey(c: PoolClient, id: string, next: { secretHash: Buffer; last4: string }): Promise<void> {
  await c.query("insert into api_key_old_secrets (secret_hash, key_id, expires_at) select secret_hash, id, now() + interval '15 minutes' from api_keys where id = $1", [id]);
  await c.query("update api_keys set secret_hash = $2, last4 = $3 where id = $1", [id, next.secretHash, next.last4]);
}

/** Capped so one sweep against a large backlog finishes inside the pool's statement
 * timeout; the next daily run drains whatever is left. The same cap, and the same reason for
 * it, as purgeOld (src/db/events.ts) and purgeExpired (src/db/idempotency.ts). */
export const SWEEP_DELETE_CAP = 5000;

/**
 * Deletes retiring secrets a full day past their expiry, at most SWEEP_DELETE_CAP per call.
 * Called by the daily sweep.
 *
 * Security sweep, finding 5: rotateKey above writes one row per rotation and nothing ever
 * removed one, so a key rotated on a schedule accumulated a hashed secret per rotation for
 * as long as it existed. Nothing here authenticates past expires_at (findKeyBySecretHash and
 * listActiveOldSecretHashes both require expires_at > now()), so a row is dead weight from
 * the moment its fifteen minute grace period ends; the extra day before it is deleted is
 * only so a row is never removed in the same minute it stops working, which keeps the
 * database a usable record of what happened while a rotation is still being investigated.
 * secret_hash is the table's own primary key, so the capped set is selected by it rather
 * than by ctid the way a table with no single id column needs, and
 * 0019_retention_indexes.sql indexes expires_at so the ordered scan walks the oldest rows
 * instead of sorting the table to find them. Takes the pool or a client: the sweep runs this
 * as a statement of its own rather than inside a shared transaction (see Queryable in
 * src/db/exchange.ts).
 */
export async function purgeExpiredOldSecrets(c: Queryable): Promise<number> {
  const r = await c.query(
    `delete from api_key_old_secrets where secret_hash in (
       select secret_hash from api_key_old_secrets where expires_at < now() - interval '1 day'
       order by expires_at limit $1
     )`, [SWEEP_DELETE_CAP]);
  return r.rowCount ?? 0;
}
