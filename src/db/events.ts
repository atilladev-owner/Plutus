import type { PoolClient } from "pg";
import type { Page, Paged, Cursored } from "./ledger.js";
import { encodeCursor } from "../domain/cursor.js";

export interface EventRow { id: string; key_id: string; ledger_id: string; type: string; entity_id: string; payload: Record<string, unknown>; created_at: Date }

export async function listEvents(c: PoolClient, keyId: string, page: Page, type: string | null): Promise<Paged<EventRow>> {
  const { rows } = await c.query<Cursored<EventRow>>(
    `select *, created_at::text as cursor_t from events where key_id = $1 and ($5::text is null or type = $5)
       and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::text))
     order by created_at desc, id desc limit $4`,
    [keyId, page.cursor?.t ?? null, page.cursor?.id ?? "", page.limit + 1, type]);
  const n = page.limit > 0 ? page.limit : 1;
  const data = rows.slice(0, n);
  const last = rows.length > n ? data[data.length - 1] : undefined;
  return { data, next_cursor: last ? encodeCursor({ t: last.cursor_t, id: last.id }) : null };
}

export async function getEvent(c: PoolClient, keyId: string, id: string): Promise<EventRow | null> {
  const { rows } = await c.query<EventRow>("select * from events where id = $1 and key_id = $2", [id, keyId]);
  return rows[0] ?? null;
}

export async function getEventsByIds(c: PoolClient, ids: string[]): Promise<EventRow[]> {
  const { rows } = await c.query<EventRow>("select * from events where id = any($1)", [ids]);
  return rows;
}
