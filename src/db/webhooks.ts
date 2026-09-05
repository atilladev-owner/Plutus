import type { PoolClient } from "pg";
import { pageOf, type Page, type Paged, type Cursored } from "./ledger.js";

export interface EndpointRow { id: string; key_id: string; url: string; secret: string; events: string[]; status: "active" | "disabled"; consecutive_failures: number; created_at: Date }
export interface DeliveryRow { id: string; endpoint_id: string; event_id: string; attempt: number; status: "pending" | "succeeded" | "failed" | "dead"; response_status: number | null; response_excerpt: string | null; next_attempt_at: Date | null; delivered_at: Date | null; created_at: Date; updated_at: Date }

export async function insertEndpoint(c: PoolClient, row: { id: string; keyId: string; url: string; secret: string; events: string[] }): Promise<EndpointRow> {
  const { rows } = await c.query<EndpointRow>("insert into webhook_endpoints (id, key_id, url, secret, events, status) values ($1, $2, $3, $4, $5, 'active') returning *",
    [row.id, row.keyId, row.url, row.secret, row.events]);
  return rows[0] as EndpointRow;
}
export async function countEndpoints(c: PoolClient, keyId: string): Promise<number> {
  const { rows } = await c.query<{ n: string }>("select count(*)::text as n from webhook_endpoints where key_id = $1", [keyId]);
  return Number(rows[0]?.n ?? "0");
}
export async function getEndpoint(c: PoolClient, keyId: string, id: string): Promise<EndpointRow | null> {
  const { rows } = await c.query<EndpointRow>("select * from webhook_endpoints where id = $1 and key_id = $2", [id, keyId]);
  return rows[0] ?? null;
}
export async function listEndpoints(c: PoolClient, keyId: string): Promise<EndpointRow[]> {
  const { rows } = await c.query<EndpointRow>("select * from webhook_endpoints where key_id = $1 order by created_at desc, id desc", [keyId]);
  return rows;
}
export async function updateEndpoint(c: PoolClient, keyId: string, id: string, patch: { url?: string; events?: string[]; status?: "active" | "disabled" }): Promise<EndpointRow | null> {
  const { rows } = await c.query<EndpointRow>(
    `update webhook_endpoints set url = coalesce($3, url), events = coalesce($4, events), status = coalesce($5, status),
       consecutive_failures = case when $5 = 'active' then 0 else consecutive_failures end
     where id = $1 and key_id = $2 returning *`, [id, keyId, patch.url ?? null, patch.events ?? null, patch.status ?? null]);
  return rows[0] ?? null;
}
export async function deleteEndpoint(c: PoolClient, keyId: string, id: string): Promise<boolean> {
  const r = await c.query("delete from webhook_endpoints where id = $1 and key_id = $2", [id, keyId]);
  return (r.rowCount ?? 0) > 0;
}
export async function disabledEndpoints(c: PoolClient, keyId: string): Promise<string[]> {
  const { rows } = await c.query<{ id: string }>("select id from webhook_endpoints where key_id = $1 and status = 'disabled'", [keyId]);
  return rows.map((r) => r.id);
}
export async function subscribedEndpoints(c: PoolClient, keyId: string, type: string): Promise<EndpointRow[]> {
  const { rows } = await c.query<EndpointRow>("select * from webhook_endpoints where key_id = $1 and status = 'active' and ($2 = any(events) or '*' = any(events))", [keyId, type]);
  return rows;
}
export async function insertDelivery(c: PoolClient, id: string, endpointId: string, eventId: string): Promise<DeliveryRow> {
  const { rows } = await c.query<DeliveryRow>("insert into webhook_deliveries (id, endpoint_id, event_id, status, next_attempt_at) values ($1, $2, $3, 'pending', now()) returning *", [id, endpointId, eventId]);
  return rows[0] as DeliveryRow;
}
export async function getDelivery(c: PoolClient, id: string): Promise<(DeliveryRow & { endpoint: EndpointRow }) | null> {
  const { rows } = await c.query<DeliveryRow & { endpoint: EndpointRow }>(
    "select d.*, to_jsonb(e.*) as endpoint from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id where d.id = $1", [id]);
  const row = rows[0];
  if (!row) return null;
  row.endpoint.created_at = new Date(row.endpoint.created_at);
  return row;
}

/** Same read as getDelivery, but locks the row for the caller's transaction and skips it
 * instead of waiting if another worker already holds it: a manual retry racing a
 * scheduled attempt, or a QStash redelivery, then finds no row and does nothing rather
 * than posting the same delivery twice. Callers must hold the row (and so this delivery)
 * for the whole attempt, HTTP call included, and release it by committing or rolling
 * back the transaction they read it in. */
export async function claimDelivery(c: PoolClient, id: string): Promise<(DeliveryRow & { endpoint: EndpointRow }) | null> {
  const { rows } = await c.query<DeliveryRow & { endpoint: EndpointRow }>(
    "select d.*, to_jsonb(e.*) as endpoint from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id where d.id = $1 for update of d skip locked", [id]);
  const row = rows[0];
  if (!row) return null;
  row.endpoint.created_at = new Date(row.endpoint.created_at);
  return row;
}
export async function recordAttempt(c: PoolClient, id: string, r: { attempt: number; status: DeliveryRow["status"]; responseStatus: number | null; excerpt: string | null; nextAttemptAt: Date | null }): Promise<void> {
  await c.query(
    `update webhook_deliveries set attempt = $2, status = $3, response_status = $4, response_excerpt = $5, next_attempt_at = $6,
       delivered_at = case when $3 = 'succeeded' then now() else delivered_at end, updated_at = now() where id = $1`,
    [id, r.attempt, r.status, r.responseStatus, r.excerpt, r.nextAttemptAt]);
}
export async function bumpFailures(c: PoolClient, endpointId: string, reset: boolean): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `update webhook_endpoints set consecutive_failures = case when $2 then 0 else consecutive_failures + 1 end,
       status = case when (not $2) and consecutive_failures + 1 >= 50 then 'disabled' else status end
     where id = $1 returning consecutive_failures as n`, [endpointId, reset]);
  return rows[0]?.n ?? 0;
}
export async function listDeliveries(c: PoolClient, endpointId: string, page: Page): Promise<Paged<DeliveryRow>> {
  const { rows } = await c.query<Cursored<DeliveryRow>>(
    `select *, created_at::text as cursor_t from webhook_deliveries where endpoint_id = $1
       and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::text))
     order by created_at desc, id desc limit $4`, [endpointId, page.cursor?.t ?? null, page.cursor?.id ?? "", page.limit + 1]);
  return pageOf(rows, page.limit);
}
export async function stalePending(c: PoolClient, olderThanMinutes: number): Promise<string[]> {
  const { rows } = await c.query<{ id: string }>("select id from webhook_deliveries where status = 'pending' and next_attempt_at < now() - ($1::int * interval '1 minute') limit 200", [olderThanMinutes]);
  return rows.map((r) => r.id);
}
