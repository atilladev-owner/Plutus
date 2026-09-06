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
        eventIds = await X.exchangeReset(c, key!.id);
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
