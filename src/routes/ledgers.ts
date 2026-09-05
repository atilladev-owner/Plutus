import { z } from "zod";
import type { PoolClient } from "pg";
import { defineRoute, parsePage } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { newId } from "../domain/ids.js";
import { ApiError, notFound } from "../domain/errors.js";
import * as L from "../db/ledger.js";
import { IdParam, PageQuery, PagedOf } from "../schemas/common.js";
import { LedgerCreate, LedgerOut } from "../schemas/ledgers.js";

export const ledgerOut = (l: L.LedgerRow) => ({
  id: l.id, name: l.name, next_seq: l.next_seq, head_hash: l.head_hash.toString("hex"),
  last_activity_at: l.last_activity_at.toISOString(), created_at: l.created_at.toISOString(),
});

/** Every ledger scoped route starts here. A ledger owned by another key is a 404, never a 403, so ids do not leak. */
export async function ownLedger(c: PoolClient, keyId: string, ledgerId: string): Promise<L.LedgerRow> {
  const l = await L.getLedger(c, keyId, ledgerId);
  if (!l) throw notFound("ledger");
  return l;
}

export const ledgerRoutes = [
  defineRoute({
    method: "post", path: "/v1/ledgers", summary: "Create a ledger", tag: "Ledgers", auth: "bearer", scope: "ledger:write", idempotent: true, status: 201,
    body: LedgerCreate, response: LedgerOut,
    // No afterCommit: creating a ledger writes no journal entry and emits no events.
    handler: async ({ key, body, tx }) => tx(async (c) => {
      if (key!.mode === "test" && (await L.countLedgers(c, key!.id)) >= 10) throw new ApiError(409, "sandbox_limit_reached", "ledgers per key: 10");
      return ledgerOut(await L.createLedger(c, { id: newId("ldg"), keyId: key!.id, name: body.name }));
    }),
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers", summary: "List ledgers", tag: "Ledgers", auth: "bearer", scope: "ledger:read",
    query: PageQuery, response: PagedOf(LedgerOut),
    handler: async ({ deps, key, query }) => withTx(deps.pool, async (c) => {
      const page = await L.listLedgers(c, key!.id, parsePage(query));
      return { data: page.data.map(ledgerOut), next_cursor: page.next_cursor };
    }),
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}", summary: "Read a ledger", tag: "Ledgers", auth: "bearer", scope: "ledger:read",
    params: z.object({ id: IdParam("ldg") }), response: LedgerOut,
    handler: async ({ deps, key, params }) => withTx(deps.pool, async (c) => ledgerOut(await ownLedger(c, key!.id, params.id))),
  }),
];
