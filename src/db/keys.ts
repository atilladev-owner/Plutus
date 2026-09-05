import type { PoolClient } from "pg";

export interface KeyRow { id: string; secret_hash: Buffer; prefix: string; last4: string; mode: "test" | "live"; scopes: string[]; created_at: Date; last_used_at: Date | null; expires_at: Date | null; revoked_at: Date | null }

// Sandbox (test mode) keys are free to mint with no auth, so they carry a bounded
// lifetime; live keys, minted only through the internal script, do not expire here.
export async function insertKey(c: PoolClient, row: { id: string; secretHash: Buffer; prefix: string; last4: string; mode: "test" | "live"; scopes: string[] }): Promise<KeyRow> {
  const { rows } = await c.query<KeyRow>(
    "insert into api_keys (id, secret_hash, prefix, last4, mode, scopes, expires_at) values ($1, $2, $3, $4, $5, $6, case when $5 = 'test' then now() + interval '90 days' else null end) returning *",
    [row.id, row.secretHash, row.prefix, row.last4, row.mode, row.scopes]);
  return rows[0] as KeyRow;
}

/** The current secret, or a retiring one still inside its grace period. A key past its own expires_at authenticates with neither. */
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

export async function touchKey(c: PoolClient, id: string): Promise<void> {
  await c.query("update api_keys set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')", [id]);
}

export async function rotateKey(c: PoolClient, id: string, next: { secretHash: Buffer; last4: string }): Promise<void> {
  await c.query("insert into api_key_old_secrets (secret_hash, key_id, expires_at) select secret_hash, id, now() + interval '15 minutes' from api_keys where id = $1", [id]);
  await c.query("update api_keys set secret_hash = $2, last4 = $3 where id = $1", [id, next.secretHash, next.last4]);
}
