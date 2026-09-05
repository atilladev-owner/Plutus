import type { PoolClient } from "pg";

export interface IdemRow { key_id: string; idem_key: string; fingerprint: Buffer; status: "pending" | "done"; response_status: number | null; response_body: unknown }

/**
 * Inserts a pending record. Returns the existing row instead if one is already there,
 * unless that row has been pending for over 60 seconds, in which case this takes it over:
 * a function killed mid request (serverless) would otherwise block the key for a full day.
 * A takeover after 60 seconds assumes the first attempt is dead, not merely slow. That
 * assumption does not follow from any single bound in this system: nothing here cancels
 * the handler itself, and each statement it runs is only bounded by the pool's own 25
 * second statement timeout, not by an overall deadline. It holds for the common case of a
 * handler with one or two statements, but the residual risk is real: a handler that runs
 * several statements in sequence under lock contention, each waiting close to the
 * statement timeout before proceeding, can still be alive and working past 60 seconds,
 * and a takeover then races a live attempt instead of replacing a dead one.
 * A returned row means we own it, fresh or taken over; no row means someone else holds it
 * and the caller falls back to the select below to decide between replay, in flight, and
 * reused.
 */
export async function claim(c: PoolClient, keyId: string, idemKey: string, fingerprint: Buffer): Promise<{ claimed: boolean; row: IdemRow }> {
  const ins = await c.query<IdemRow>(
    `insert into idempotency_keys (key_id, idem_key, fingerprint, status, expires_at)
     values ($1, $2, $3, 'pending', now() + interval '24 hours')
     on conflict (key_id, idem_key) do update set
       fingerprint = excluded.fingerprint,
       status = 'pending',
       response_status = null,
       response_body = null,
       created_at = now(),
       expires_at = excluded.expires_at
     where idempotency_keys.status = 'pending' and idempotency_keys.created_at < now() - interval '60 seconds'
     returning *`, [keyId, idemKey, fingerprint]);
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

/** Capped so one sweep against a large backlog finishes inside the pool's statement
 * timeout; the next daily run drains whatever is left. */
export const SWEEP_DELETE_CAP = 5000;

/** Deletes idempotency records past their expiry, at most SWEEP_DELETE_CAP per call.
 * Called by the daily sweep. idempotency_keys has no single id column (its primary key is
 * (key_id, idem_key)), so ctid, Postgres's own physical row identifier, selects the capped
 * set instead. */
export async function purgeExpired(c: PoolClient): Promise<number> {
  const r = await c.query(
    `delete from idempotency_keys where ctid in (
       select ctid from idempotency_keys where expires_at < now() order by created_at limit $1
     )`, [SWEEP_DELETE_CAP]);
  return r.rowCount ?? 0;
}
