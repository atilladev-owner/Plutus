import { z } from "zod";
import { defineRoute } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { ApiError } from "../domain/errors.js";
import * as X from "../db/exchange.js";
import { BalancesOut } from "../schemas/exchange.js";
import { afterCommit } from "../platform/fanout.js";
import type { AuthedKey } from "../platform/route.js";

function requireSandbox(key: AuthedKey): void {
  if (key.mode !== "test") throw new ApiError(403, "sandbox_only", "the faucet and the reset are sandbox only");
}

export const exchangeWalletRoutes = [
  defineRoute({
    method: "post", path: "/v1/exchange/faucet", summary: "Fund the caller's sandbox exchange wallet from the world", tag: "Exchange",
    auth: "signed", scope: "exchange:trade", weight: 5, idempotent: true,
    body: z.object({}).optional(), response: BalancesOut,
    handler: async ({ key, tx, deps }) => {
      requireSandbox(key!);
      let eventIds: string[] = [];
      const out = await tx(async (c) => {
        eventIds = await X.exchangeFaucet(c, key!.id);
        return { data: await X.listExchangeBalances(c, key!.id) };
      });
      await afterCommit(deps, eventIds);
      return out;
    },
  }),
  defineRoute({
    method: "post", path: "/v1/exchange/reset", summary: "Reset the caller's sandbox exchange wallet to the faucet amounts", tag: "Exchange",
    auth: "signed", scope: "exchange:trade", weight: 5, idempotent: true,
    body: z.object({}).optional(), response: BalancesOut,
    handler: async ({ key, tx, deps }) => {
      requireSandbox(key!);
      let eventIds: string[] = [];
      const out = await tx(async (c) => {
        // Now that place_order and cancel_order exist (task 5), reset cancels every open
        // order the key owns through cancel_order first, so each one leaves an
        // order.cancelled market event and key event behind exactly like an explicit
        // cancel would, before exchangeReset releases whatever hold, if any, is not tied to
        // an order and nets every balance back to the faucet amounts. lock_markets runs
        // first, on every market, exactly as exchangeReset's own first statement already
        // does (0012_exchange_wallet.sql): taken here too, ahead of the per order cancel
        // loop, so this handler never acquires more than one market's lock in whatever
        // order the orders happen to have been created, only ever in the one sorted order
        // every lock taker in this codebase agrees on (spec 10.4 step 7). Re-locking what
        // exchangeReset's own call re-takes a moment later is a no-op in the same
        // transaction, never a race.
        await X.lockMarkets(c, X.MARKETS);
        const openOrderIds = await X.listOpenOrderIds(c, key!.id, null);
        for (const orderId of openOrderIds) {
          const r = await X.cancelOrder(c, key!.id, orderId);
          eventIds = eventIds.concat(r.event_ids);
        }
        eventIds = eventIds.concat(await X.exchangeReset(c, key!.id));
        return { data: await X.listExchangeBalances(c, key!.id) };
      });
      await afterCommit(deps, eventIds);
      return out;
    },
  }),
  defineRoute({
    method: "get", path: "/v1/exchange/balances", summary: "List the caller's exchange balances", tag: "Exchange",
    auth: "signed", scope: "exchange:trade", weight: 5,
    response: BalancesOut,
    handler: async ({ deps, key }) => withTx(deps.pool, async (c) => ({ data: await X.listExchangeBalances(c, key!.id) })),
  }),
];
