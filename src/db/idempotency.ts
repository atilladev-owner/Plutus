import type { PoolClient } from "pg";

export interface IdemRow { key_id: string; idem_key: string; fingerprint: Buffer; status: "pending" | "done"; response_status: number | null; response_body: unknown }

/** Inserts a pending record. Returns the existing row instead if one is already there. */
export async function claim(c: PoolClient, keyId: string, idemKey: string, fingerprint: Buffer): Promise<{ claimed: boolean; row: IdemRow }> {
  const ins = await c.query<IdemRow>(
    `insert into idempotency_keys (key_id, idem_key, fingerprint, status, expires_at)
     values ($1, $2, $3, 'pending', now() + interval '24 hours')
     on conflict (key_id, idem_key) do nothing returning *`, [keyId, idemKey, fingerprint]);
  if (ins.rows[0]) return { claimed: true, row: ins.rows[0] };
  const { rows } = await c.query<IdemRow>("select * from idempotency_keys where key_id = $1 and idem_key = $2", [keyId, idemKey]);
  return { claimed: false, row: rows[0] as IdemRow };
}

export async function complete(c: PoolClient, keyId: string, idemKey: string, status: number, body: unknown): Promise<void> {
  await c.query("update idempotency_keys set status = 'done', response_status = $3, response_body = $4::jsonb where key_id = $1 and idem_key = $2",
    [keyId, idemKey, status, JSON.stringify(body)]);
}

export async function abandon(c: PoolClient, keyId: string, idemKey: string): Promise<void> {
  await c.query("delete from idempotency_keys where key_id = $1 and idem_key = $2 and status = 'pending'", [keyId, idemKey]);
}
