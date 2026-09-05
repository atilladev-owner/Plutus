import type { PoolClient } from "pg";
import { pageOf, type Page, type Paged, type Cursored } from "./ledger.js";

export interface EventRow { id: string; key_id: string; ledger_id: string; type: string; entity_id: string; payload: Record<string, unknown>; created_at: Date }

export async function listEvents(c: PoolClient, keyId: string, page: Page, type: string | null): Promise<Paged<EventRow>> {
  const { rows } = await c.query<Cursored<EventRow>>(
    `select *, created_at::text as cursor_t from events where key_id = $1 and ($5::text is null or type = $5)
       and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::text))
     order by created_at desc, id desc limit $4`,
    [keyId, page.cursor?.t ?? null, page.cursor?.id ?? "", page.limit + 1, type]);
  return pageOf(rows, page.limit);
}

export async function getEvent(c: PoolClient, keyId: string, id: string): Promise<EventRow | null> {
  const { rows } = await c.query<EventRow>("select * from events where id = $1 and key_id = $2", [id, keyId]);
  return rows[0] ?? null;
}

export async function getEventsByIds(c: PoolClient, ids: string[]): Promise<EventRow[]> {
  const { rows } = await c.query<EventRow>("select * from events where id = any($1)", [ids]);
  return rows;
}

/** Capped so one sweep against a large backlog finishes inside the pool's statement
 * timeout; the next daily run drains whatever is left. */
export const SWEEP_DELETE_CAP = 5000;

/** Deletes events older than 30 days, at most SWEEP_DELETE_CAP per call. Called by the daily sweep. */
export async function purgeOld(c: PoolClient): Promise<number> {
  const r = await c.query(
    `delete from events where id in (
       select id from events where created_at < now() - interval '30 days' order by created_at limit $1
     )`, [SWEEP_DELETE_CAP]);
  return r.rowCount ?? 0;
}
