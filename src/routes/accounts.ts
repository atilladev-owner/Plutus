import { z } from "zod";
import { defineRoute, parsePage } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { newId } from "../domain/ids.js";
import { ApiError, notFound, validation } from "../domain/errors.js";
import * as L from "../db/ledger.js";
import { IdParam, PageQuery, PagedOf } from "../schemas/common.js";
import { AccountCreate, AccountOut } from "../schemas/accounts.js";
import { ownLedger } from "./ledgers.js";

export const accountOut = (a: L.AccountRow) => ({
  id: a.id, ledger_id: a.ledger_id, asset: a.asset, name: a.name, kind: a.kind,
  balance: a.balance, held: a.held, available: (BigInt(a.balance) - BigInt(a.held)).toString(),
  metadata: a.metadata, created_at: a.created_at.toISOString(),
});

const Params = z.object({ id: IdParam("ldg") });
const AccountParams = Params.extend({ accountId: IdParam("acct") });

export const accountRoutes = [
  defineRoute({
    method: "post", path: "/v1/ledgers/{id}/accounts", summary: "Create an account", tag: "Accounts", auth: "bearer", scope: "ledger:write", idempotent: true, status: 201,
    params: Params, body: AccountCreate, response: AccountOut,
    handler: async ({ key, params, body, tx }) => tx(async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      const asset = await c.query("select 1 from assets where code = $1", [body.asset]);
      if (asset.rowCount === 0) throw validation("unknown asset", [{ path: "asset", message: `no asset ${body.asset}` }]);
      if (key!.mode === "test" && (await L.countAccounts(c, ledger.id)) >= 50) throw new ApiError(409, "sandbox_limit_reached", "accounts per ledger: 50");
      return accountOut(await L.createAccount(c, { id: newId("acct"), ledgerId: ledger.id, asset: body.asset, name: body.name, metadata: body.metadata }));
    }),
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/accounts", summary: "List accounts", tag: "Accounts", auth: "bearer", scope: "ledger:read",
    params: Params, query: PageQuery, response: PagedOf(AccountOut),
    handler: async ({ deps, key, params, query }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      await L.expireHolds(c, ledger.id, null);
      const page = await L.listAccounts(c, ledger.id, parsePage(query));
      return { data: page.data.map(accountOut), next_cursor: page.next_cursor };
    }),
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/accounts/{accountId}", summary: "Read an account", tag: "Accounts", auth: "bearer", scope: "ledger:read",
    params: AccountParams, response: AccountOut,
    handler: async ({ deps, key, params }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      await L.expireHolds(c, ledger.id, params.accountId);
      const a = await L.getAccount(c, ledger.id, params.accountId);
      if (!a) throw notFound("account");
      return accountOut(a);
    }),
  }),
];
