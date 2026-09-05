import { z } from "zod";
import { defineRoute, parsePage } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { newId } from "../domain/ids.js";
import { notFound } from "../domain/errors.js";
import * as L from "../db/ledger.js";
import { IdParam, PageQuery, PagedOf } from "../schemas/common.js";
import { HoldCreate, HoldCapture, HoldOut, HoldCaptureOut, HoldReleaseOut } from "../schemas/holds.js";
import { ownLedger } from "./ledgers.js";
import { transferOut } from "./transfers.js";
import { afterCommit } from "../platform/fanout.js";

export const holdOut = (h: L.HoldRow) => ({
  id: h.id, ledger_id: h.ledger_id, account_id: h.account_id, asset: h.asset, amount: h.amount, remaining: h.remaining,
  status: h.status, expires_at: h.expires_at.toISOString(), memo: h.memo, metadata: h.metadata,
  created_at: h.created_at.toISOString(), closed_at: h.closed_at?.toISOString() ?? null,
});

const Params = z.object({ id: IdParam("ldg") });
const HoldParams = Params.extend({ holdId: IdParam("hold") });

export const holdRoutes = [
  defineRoute({
    method: "post", path: "/v1/ledgers/{id}/holds", summary: "Hold funds on an account", tag: "Holds", auth: "bearer", scope: "ledger:write", idempotent: true, status: 201,
    params: Params, body: HoldCreate, response: HoldOut,
    handler: async ({ deps, key, params, body, tx }) => {
      let eventIds: string[] = [];
      const out = await tx(async (c) => {
        const ledger = await ownLedger(c, key!.id, params.id);
        const r = await L.createHold(c, { ledgerId: ledger.id, holdId: newId("hold"), accountId: body.account, amount: body.amount,
          expiresAt: new Date(Date.now() + body.expires_in_seconds * 1000), memo: body.memo, metadata: body.metadata });
        eventIds = r.event_ids;
        return holdOut((await L.getHold(c, ledger.id, r.id))!);
      });
      await afterCommit(deps, eventIds);
      return out;
    },
  }),
  defineRoute({
    method: "post", path: "/v1/ledgers/{id}/holds/{holdId}/capture", summary: "Capture some or all of a hold into a transfer", tag: "Holds", auth: "bearer", scope: "ledger:write", idempotent: true,
    params: HoldParams, body: HoldCapture, response: HoldCaptureOut,
    handler: async ({ deps, key, params, body, tx }) => {
      let eventIds: string[] = [];
      const out = await tx(async (c) => {
        const ledger = await ownLedger(c, key!.id, params.id);
        const hold = await L.getHold(c, ledger.id, params.holdId);
        if (!hold) throw notFound("hold");
        const amount = body.amount ?? hold.remaining;
        const r = await L.postTransfer(c, { ledgerId: ledger.id, transferId: newId("tr"), legs: [{ from_hold: hold.id, to: body.to, asset: hold.asset, amount }], memo: `capture ${hold.id}`, metadata: {} });
        eventIds = [...r.event_ids];
        const after = (await L.getHold(c, ledger.id, hold.id))!;
        if (body.release_remainder && after.status === "open") {
          eventIds.push(...(await L.releaseHold(c, ledger.id, hold.id, "hold.released")).event_ids);
          // release_hold is the shared primitive for freeing held funds; it always leaves the
          // hold "released". A capture that also released its remainder already moved money
          // out through this same request, so it reads as captured, never as released, which
          // would wrongly imply nothing was captured. The journal keeps its accurate
          // "hold.released" entry for the remainder; only the terminal label is corrected here.
          await c.query("update holds set status = 'captured' where id = $1", [hold.id]);
        }
        return { hold: holdOut((await L.getHold(c, ledger.id, hold.id))!), transfer: transferOut((await L.getTransfer(c, ledger.id, r.id))!) };
      });
      await afterCommit(deps, eventIds);
      return out;
    },
  }),
  defineRoute({
    method: "post", path: "/v1/ledgers/{id}/holds/{holdId}/release", summary: "Release what remains of a hold", tag: "Holds", auth: "bearer", scope: "ledger:write", idempotent: true,
    params: HoldParams, body: z.object({}).optional(), response: HoldReleaseOut,
    handler: async ({ deps, key, params, tx }) => {
      let eventIds: string[] = [];
      const out = await tx(async (c) => {
        const ledger = await ownLedger(c, key!.id, params.id);
        if (!(await L.getHold(c, ledger.id, params.holdId))) throw notFound("hold");
        const r = await L.releaseHold(c, ledger.id, params.holdId, "hold.released");
        eventIds = r.event_ids;
        return { hold: holdOut((await L.getHold(c, ledger.id, params.holdId))!), released: r.released };
      });
      await afterCommit(deps, eventIds);
      return out;
    },
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/holds", summary: "List holds", tag: "Holds", auth: "bearer", scope: "ledger:read",
    params: Params, query: PageQuery.extend({ account: IdParam("acct").optional(), status: z.enum(["open", "captured", "released", "expired"]).optional() }), response: PagedOf(HoldOut),
    handler: async ({ deps, key, params, query }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      await L.expireHolds(c, ledger.id, query.account ?? null);
      const page = await L.listHolds(c, ledger.id, parsePage(query), { accountId: query.account ?? null, status: query.status ?? null });
      return { data: page.data.map(holdOut), next_cursor: page.next_cursor };
    }),
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/holds/{holdId}", summary: "Read a hold", tag: "Holds", auth: "bearer", scope: "ledger:read",
    params: HoldParams, response: HoldOut,
    handler: async ({ deps, key, params }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      const before = await L.getHold(c, ledger.id, params.holdId);
      if (!before) throw notFound("hold");
      await L.expireHolds(c, ledger.id, before.account_id);
      return holdOut((await L.getHold(c, ledger.id, params.holdId))!);
    }),
  }),
];
