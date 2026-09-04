import type { PoolClient } from "pg";
import { encodeCursor, type Cursor } from "../domain/cursor.js";

export interface Page { limit: number; cursor: Cursor | null }
export interface Paged<T> { data: T[]; next_cursor: string | null }

export interface LedgerRow { id: string; key_id: string; name: string; next_seq: string; head_hash: Buffer; last_activity_at: Date; created_at: Date }
export interface AccountRow { id: string; ledger_id: string; asset: string; name: string; kind: "normal" | "world"; balance: string; held: string; metadata: Record<string, string>; created_at: Date }
export interface TransferRow { id: string; ledger_id: string; seq: string; memo: string; metadata: Record<string, string>; created_at: Date; legs: LegRow[] }
export interface LegRow { position: number; from_account: string; from_hold: string | null; to_account: string; asset: string; amount: string }
export interface HoldRow { id: string; ledger_id: string; account_id: string; asset: string; amount: string; remaining: string; status: "open" | "captured" | "released" | "expired"; expires_at: Date; memo: string; metadata: Record<string, string>; created_at: Date; closed_at: Date | null }
export interface JournalRow { ledger_id: string; seq: string; kind: string; entity_id: string; payload: Record<string, unknown>; prev_hash: Buffer; hash: Buffer; created_at: Date }
export interface LegInput { from?: string; from_hold?: string; to: string; asset: string; amount: string }
export interface WriteResult { id: string; seq: string; event_ids: string[] }

/** Newest first pagination over (created_at, id). Fetches one extra row to learn if there is a next page. */
function pageOf<T extends { created_at: Date; id: string }>(rows: T[], limit: number): Paged<T> {
  const data = rows.slice(0, limit);
  const last = rows.length > limit ? data[data.length - 1] : undefined;
  return { data, next_cursor: last ? encodeCursor({ t: last.created_at.toISOString(), id: last.id }) : null };
}

export async function createLedger(c: PoolClient, input: { id: string; keyId: string; name: string }): Promise<LedgerRow> {
  const { rows } = await c.query<LedgerRow>(
    "insert into ledgers (id, key_id, name) values ($1, $2, $3) returning *", [input.id, input.keyId, input.name]);
  return rows[0] as LedgerRow;
}

export async function getLedger(c: PoolClient, keyId: string, ledgerId: string): Promise<LedgerRow | null> {
  const { rows } = await c.query<LedgerRow>("select * from ledgers where id = $1 and key_id = $2", [ledgerId, keyId]);
  return rows[0] ?? null;
}

export async function countLedgers(c: PoolClient, keyId: string): Promise<number> {
  const { rows } = await c.query<{ n: string }>("select count(*)::text as n from ledgers where key_id = $1", [keyId]);
  return Number(rows[0]?.n ?? "0");
}

export async function listLedgers(c: PoolClient, keyId: string, page: Page): Promise<Paged<LedgerRow>> {
  const { rows } = await c.query<LedgerRow>(
    `select * from ledgers where key_id = $1
       and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::text))
     order by created_at desc, id desc limit $4`,
    [keyId, page.cursor?.t ?? null, page.cursor?.id ?? "", page.limit + 1]);
  return pageOf(rows, page.limit);
}

export async function createAccount(c: PoolClient, input: { id: string; ledgerId: string; asset: string; name: string; metadata: Record<string, string> }): Promise<AccountRow> {
  const { rows } = await c.query<AccountRow>(
    "insert into accounts (id, ledger_id, asset, name, kind, metadata) values ($1, $2, $3, $4, 'normal', $5) returning *",
    [input.id, input.ledgerId, input.asset, input.name, JSON.stringify(input.metadata)]);
  return rows[0] as AccountRow;
}

export async function getAccount(c: PoolClient, ledgerId: string, accountId: string): Promise<AccountRow | null> {
  const { rows } = await c.query<AccountRow>("select * from accounts where id = $1 and ledger_id = $2", [accountId, ledgerId]);
  return rows[0] ?? null;
}

export async function countAccounts(c: PoolClient, ledgerId: string): Promise<number> {
  const { rows } = await c.query<{ n: string }>("select count(*)::text as n from accounts where ledger_id = $1 and kind = 'normal'", [ledgerId]);
  return Number(rows[0]?.n ?? "0");
}

export async function listAccounts(c: PoolClient, ledgerId: string, page: Page): Promise<Paged<AccountRow>> {
  const { rows } = await c.query<AccountRow>(
    `select * from accounts where ledger_id = $1
       and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::text))
     order by created_at desc, id desc limit $4`,
    [ledgerId, page.cursor?.t ?? null, page.cursor?.id ?? "", page.limit + 1]);
  return pageOf(rows, page.limit);
}

export async function postTransfer(c: PoolClient, input: { ledgerId: string; transferId: string; legs: LegInput[]; memo: string; metadata: Record<string, string> }): Promise<WriteResult> {
  const { rows } = await c.query<{ r: { id: string; seq: number; event_ids: string[] } }>(
    "select post_transfer($1, $2, $3::jsonb, $4, $5::jsonb, now()) as r",
    [input.ledgerId, input.transferId, JSON.stringify(input.legs), input.memo, JSON.stringify(input.metadata)]);
  const r = (rows[0] as { r: { id: string; seq: number; event_ids: string[] } }).r;
  return { id: r.id, seq: String(r.seq), event_ids: r.event_ids };
}

export async function getTransfer(c: PoolClient, ledgerId: string, transferId: string): Promise<TransferRow | null> {
  const { rows } = await c.query<TransferRow>(
    `select t.*, coalesce((select json_agg(json_build_object(
        'position', l.position, 'from_account', l.from_account, 'from_hold', l.from_hold,
        'to_account', l.to_account, 'asset', l.asset, 'amount', l.amount::text) order by l.position)
       from transfer_legs l where l.transfer_id = t.id), '[]'::json) as legs
     from transfers t where t.id = $1 and t.ledger_id = $2`, [transferId, ledgerId]);
  return rows[0] ?? null;
}

export async function listTransfers(c: PoolClient, ledgerId: string, page: Page, accountId: string | null): Promise<Paged<TransferRow>> {
  const { rows } = await c.query<TransferRow>(
    `select t.*, coalesce((select json_agg(json_build_object(
        'position', l.position, 'from_account', l.from_account, 'from_hold', l.from_hold,
        'to_account', l.to_account, 'asset', l.asset, 'amount', l.amount::text) order by l.position)
       from transfer_legs l where l.transfer_id = t.id), '[]'::json) as legs
     from transfers t
     where t.ledger_id = $1
       and ($2::timestamptz is null or (t.created_at, t.id) < ($2::timestamptz, $3::text))
       and ($5::text is null or exists (select 1 from transfer_legs l where l.transfer_id = t.id and (l.from_account = $5 or l.to_account = $5)))
     order by t.created_at desc, t.id desc limit $4`,
    [ledgerId, page.cursor?.t ?? null, page.cursor?.id ?? "", page.limit + 1, accountId]);
  return pageOf(rows, page.limit);
}

export async function createHold(c: PoolClient, input: { ledgerId: string; holdId: string; accountId: string; amount: string; expiresAt: Date; memo: string; metadata: Record<string, string> }): Promise<WriteResult> {
  const { rows } = await c.query<{ r: { id: string; seq: number; event_ids: string[] } }>(
    "select create_hold($1, $2, $3, $4::bigint, $5, $6, $7::jsonb, now()) as r",
    [input.ledgerId, input.holdId, input.accountId, input.amount, input.expiresAt, input.memo, JSON.stringify(input.metadata)]);
  const r = (rows[0] as { r: { id: string; seq: number; event_ids: string[] } }).r;
  return { id: r.id, seq: String(r.seq), event_ids: r.event_ids };
}

export async function releaseHold(c: PoolClient, ledgerId: string, holdId: string, kind: "hold.released" | "hold.expired"): Promise<WriteResult & { released: string }> {
  const { rows } = await c.query<{ r: { id: string; released: string; seq: number; event_ids: string[] } }>(
    "select release_hold($1, $2, $3, now()) as r", [ledgerId, holdId, kind]);
  const r = (rows[0] as { r: { id: string; released: string; seq: number; event_ids: string[] } }).r;
  return { id: r.id, seq: String(r.seq), event_ids: r.event_ids, released: r.released };
}

export async function expireHolds(c: PoolClient, ledgerId: string, accountId: string | null): Promise<number> {
  const { rows } = await c.query<{ n: number }>("select expire_holds($1, $2, now()) as n", [ledgerId, accountId]);
  return rows[0]?.n ?? 0;
}

export async function getHold(c: PoolClient, ledgerId: string, holdId: string): Promise<HoldRow | null> {
  const { rows } = await c.query<HoldRow>("select * from holds where id = $1 and ledger_id = $2", [holdId, ledgerId]);
  return rows[0] ?? null;
}

export async function listHolds(c: PoolClient, ledgerId: string, page: Page, filters: { accountId: string | null; status: string | null }): Promise<Paged<HoldRow>> {
  const { rows } = await c.query<HoldRow>(
    `select * from holds where ledger_id = $1
       and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::text))
       and ($5::text is null or account_id = $5) and ($6::text is null or status = $6)
     order by created_at desc, id desc limit $4`,
    [ledgerId, page.cursor?.t ?? null, page.cursor?.id ?? "", page.limit + 1, filters.accountId, filters.status]);
  return pageOf(rows, page.limit);
}

export async function countOpenHolds(c: PoolClient, accountId: string): Promise<number> {
  const { rows } = await c.query<{ n: string }>("select count(*)::text as n from holds where account_id = $1 and status = 'open'", [accountId]);
  return Number(rows[0]?.n ?? "0");
}

export async function listJournal(c: PoolClient, ledgerId: string, sinceSeq: bigint, limit: number): Promise<JournalRow[]> {
  const { rows } = await c.query<JournalRow>(
    "select * from journal where ledger_id = $1 and seq > $2::bigint order by seq asc limit $3",
    [ledgerId, sinceSeq.toString(), limit]);
  return rows;
}
