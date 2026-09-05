import { z } from "zod";
import { Receiver } from "@upstash/qstash";
import { defineRoute } from "../platform/route.js";
import { ApiError } from "../domain/errors.js";
import { deliverOnce } from "../platform/deliver.js";
import { safeEqual } from "../platform/auth.js";
import type { AppDeps } from "../deps.js";
import { withTx } from "../db/pool.js";
import * as L from "../db/ledger.js";
import * as W from "../db/webhooks.js";
import { purgeOld } from "../db/events.js";
import { purgeExpired } from "../db/idempotency.js";

const SweepOut = z.object({
  expired_holds: z.number().int(),
  deleted_ledgers: z.number().int(),
  deleted_keys: z.number().int(),
  deleted_events: z.number().int(),
  deleted_idempotency: z.number().int(),
  republished_deliveries: z.number().int(),
});

/**
 * Daily housekeeping, in three transactions. The first expires holds whose time is up and
 * commits on its own. The second deletes idle sandbox ledgers and keys, alone: a ledger
 * delete cascades to its accounts, transfers, legs, holds and journal rows, so against a
 * large enough idle backlog it can run long enough on its own to hit the pool's 25 second
 * statement timeout, and this way that timeout costs only this purge, not the event purge,
 * the idempotency purge or the stale delivery republish. The third purges old events and
 * expired idempotency records (each capped, see SWEEP_DELETE_CAP in the respective db
 * module), and republishes any delivery left pending past its due time (stalePending, in
 * src/db/webhooks.ts): one QStash message lost never costs a delivery, only a delay.
 * Guarded by CRON_SECRET compared in constant time; a missing secret refuses every call
 * rather than accepting one.
 */
async function sweep({ deps, req }: { deps: AppDeps; req: import("express").Request }) {
  const secret = deps.config.CRON_SECRET;
  const header = req.header("authorization") ?? "";
  if (!secret || !safeEqual(header, `Bearer ${secret}`)) throw new ApiError(401, "unauthorized", "internal route");
  // Hold expiry commits in its own transaction before any purge runs. Each purge below is
  // capped, but a large enough uncapped backlog elsewhere, or a slow plan, can still hit
  // the pool's 25 second statement timeout; if that happened inside the same transaction
  // as the hold expiry loop, the failure would roll back holds that had already, correctly,
  // expired, and the next run would face the same backlog and fail the same way.
  const expiredHolds = await withTx(deps.pool, async (c) => {
    let n = 0;
    for (const id of await L.ledgersWithExpiredHolds(c)) n += await L.expireHolds(c, id, null);
    return n;
  });
  const idle = await withTx(deps.pool, (c) => L.deleteIdleSandbox(c));
  const out = await withTx(deps.pool, async (c) => {
    const events = await purgeOld(c);
    const idem = await purgeExpired(c);
    const stale = await W.stalePending(c, 60);
    return { deleted_events: events, deleted_idempotency: idem, stale };
  });
  for (const id of out.stale) await deps.scheduler.schedule(id, 0);
  const { stale, ...rest } = out;
  return { expired_holds: expiredHolds, deleted_ledgers: idle.ledgers, deleted_keys: idle.keys, ...rest, republished_deliveries: stale.length };
}

export const internalRoutes = [
  defineRoute({ method: "get", path: "/internal/sweep", summary: "Daily housekeeping", tag: "Internal", auth: "none", limit: "none", response: SweepOut, handler: sweep }),
  defineRoute({ method: "post", path: "/internal/sweep", summary: "Daily housekeeping", tag: "Internal", auth: "none", limit: "none", response: SweepOut, handler: sweep }),
  defineRoute({
    method: "post", path: "/internal/webhooks/deliver", summary: "QStash callback that makes one delivery attempt", tag: "Internal", auth: "none", limit: "none",
    body: z.object({ delivery_id: z.string().regex(/^whd_[0-9a-f]{32}$/) }), response: z.object({ ok: z.boolean() }),
    handler: async ({ deps, body, req }) => {
      const { QSTASH_CURRENT_SIGNING_KEY: cur, QSTASH_NEXT_SIGNING_KEY: nxt, CRON_SECRET } = deps.config;
      const internal = req.header("x-plutus-internal") ?? "";
      if (cur && nxt) {
        const sig = req.header("upstash-signature") ?? "";
        // Verify against the exact bytes the body was sent as (req.rawBody, captured by
        // express.json's verify option), not JSON.stringify(req.body): re-serialising is
        // not guaranteed to match byte for byte what QStash actually signed.
        const ok = await new Receiver({ currentSigningKey: cur, nextSigningKey: nxt }).verify({ signature: sig, body: req.rawBody?.toString("utf8") ?? "", url: `${deps.config.PUBLIC_BASE_URL}/internal/webhooks/deliver` }).catch(() => false);
        if (!ok) throw new ApiError(401, "invalid_signature", "QStash signature did not verify");
      } else if (!CRON_SECRET || !safeEqual(internal, CRON_SECRET)) {
        throw new ApiError(401, "unauthorized", "internal route");
      }
      await deliverOnce(deps, body.delivery_id);
      return { ok: true };
    },
  }),
];
