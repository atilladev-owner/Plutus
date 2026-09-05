import { z } from "zod";
import { defineRoute, parsePage } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { newId } from "../domain/ids.js";
import { notFound } from "../domain/errors.js";
import * as L from "../db/ledger.js";
import { IdParam, PageQuery, PagedOf } from "../schemas/common.js";
import { TransferCreate, TransferOut } from "../schemas/transfers.js";
import { ownLedger } from "./ledgers.js";
import { afterCommit } from "../platform/fanout.js";

export const transferOut = (t: L.TransferRow) => ({
  id: t.id, ledger_id: t.ledger_id, seq: t.seq, memo: t.memo, metadata: t.metadata, created_at: t.created_at.toISOString(),
  legs: t.legs.map((l) => ({ position: l.position, from: l.from_account, from_hold: l.from_hold, to: l.to_account, asset: l.asset, amount: l.amount })),
});

const Params = z.object({ id: IdParam("ldg") });

export const transferRoutes = [
  defineRoute({
    method: "post", path: "/v1/ledgers/{id}/transfers", summary: "Post a transfer of one or more legs, atomically", tag: "Transfers", auth: "bearer", scope: "ledger:write", idempotent: true, status: 201,
    params: Params, body: TransferCreate, response: TransferOut,
    handler: async ({ deps, key, params, body, tx }) => {
      let eventIds: string[] = [];
      const out = await tx(async (c) => {
        const ledger = await ownLedger(c, key!.id, params.id);
        const r = await L.postTransfer(c, { ledgerId: ledger.id, transferId: newId("tr"), legs: body.legs, memo: body.memo, metadata: body.metadata });
        eventIds = r.event_ids;
        const t = await L.getTransfer(c, ledger.id, r.id);
        return transferOut(t!);
      });
      await afterCommit(deps, eventIds);
      return out;
    },
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/transfers", summary: "List transfers, newest first", tag: "Transfers", auth: "bearer", scope: "ledger:read",
    params: Params, query: PageQuery.extend({ account: IdParam("acct").optional() }), response: PagedOf(TransferOut),
    handler: async ({ deps, key, params, query }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      const page = await L.listTransfers(c, ledger.id, parsePage(query), query.account ?? null);
      return { data: page.data.map(transferOut), next_cursor: page.next_cursor };
    }),
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/transfers/{transferId}", summary: "Read a transfer", tag: "Transfers", auth: "bearer", scope: "ledger:read",
    params: Params.extend({ transferId: IdParam("tr") }), response: TransferOut,
    handler: async ({ deps, key, params }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      const t = await L.getTransfer(c, ledger.id, params.transferId);
      if (!t) throw notFound("transfer");
      return transferOut(t);
    }),
  }),
];
