import { createHash } from "node:crypto";
import { z } from "zod";
import type { Response } from "express";
import { defineRoute, parsePage } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { notFound } from "../domain/errors.js";
import { isId, newId } from "../domain/ids.js";
import { stableJson } from "../domain/canonical.js";
import { complete } from "../db/idempotency.js";
import { afterCommit } from "../platform/fanout.js";
import * as X from "../db/exchange.js";
import type { AppDeps } from "../deps.js";
import { IdParam, PageQuery, PagedOf } from "../schemas/common.js";
import { OrderCreate, OrderOut, OrdersOut, OrderStatus, MarketSymbol, TradeOut } from "../schemas/exchange.js";

function orderOut(o: X.OrderRow) {
  return {
    id: o.id, market: o.market, client_order_id: o.client_order_id, side: o.side, type: o.type,
    time_in_force: o.time_in_force, post_only: o.post_only, price: o.price, quantity: o.quantity,
    quote_amount: o.quote_amount, filled_quantity: o.filled_quantity, filled_quote: o.filled_quote,
    status: o.status, hold_id: o.hold_id, accepted_seq: o.accepted_seq, reject_reason: o.reject_reason,
    created_at: o.created_at, updated_at: o.updated_at,
  };
}

function tradeOut(t: X.MyTradeRow) {
  return {
    id: t.id, market: t.market, seq: t.seq, buy_order_id: t.buy_order_id, sell_order_id: t.sell_order_id,
    price: t.price, quantity: t.quantity, notional: t.notional, buyer_fee: t.buyer_fee, seller_fee: t.seller_fee,
    transfer_id: t.transfer_id, side: t.side, created_at: t.created_at,
  };
}

/** Review round 1, finding 4: the fingerprint stored on an order row, and compared against
 * a retried body, is the hex SHA-256 of the stable JSON, not the stable JSON text itself. */
function fingerprintOf(body: unknown): string {
  return createHash("sha256").update(stableJson(body ?? null), "utf8").digest("hex");
}

interface IdemLocals { keyId: string; idemKey: string; stored: boolean }

/**
 * Answers an idempotent replay of a placement with 200, not this route's own 201, however
 * it was found: the plain lookup before place_order was ever called, or the race repair in
 * the catch block below. mountRoutes (src/platform/route.ts) only ever falls back to
 * def.status when the handler leaves res.statusCode at Express's own default of 200, and
 * res.statusCode already reads exactly 200 whether the handler touched it or not, so
 * getting an actual 200 out of a status: 201 route means answering the request here
 * directly rather than returning a value for mountRoutes to send. That in turn means
 * finishing the Idempotency-Key claim by hand, exactly the way ctx.tx would inside its own
 * transaction, since mountRoutes skips its own completion block once headers are already
 * sent (res.headersSent).
 */
async function respondReplayed(deps: AppDeps, res: Response, existing: X.OrderRow): Promise<ReturnType<typeof orderOut>> {
  const out = orderOut(existing);
  const idem = res.locals.idem as IdemLocals | undefined;
  if (idem && !idem.stored) {
    const client = await deps.pool.connect();
    try {
      await complete(client, idem.keyId, idem.idemKey, 200, out);
      idem.stored = true;
    } finally {
      client.release();
    }
  }
  res.setHeader("Idempotent-Replayed", "true");
  res.status(200).json(out);
  return out;
}

const OrderIdParam = z.object({ id: IdParam("ord") });
// Cancel by id accepts a client_order_id too (spec 10.10), so its path segment cannot be
// pinned to the ord_ shape the way every other single order lookup here is.
const OrderIdOrClientOrderIdParam = z.object({ id: z.string().min(1).max(100) });

export const exchangeOrderRoutes = [
  defineRoute({
    method: "post", path: "/v1/exchange/orders", summary: "Place an order", tag: "Exchange",
    auth: "signed", scope: "exchange:trade", weight: 1, placement: true, idempotent: true, status: 201,
    body: OrderCreate, response: OrderOut,
    handler: async ({ key, body, req, res, deps, tx }) => {
      // client_order_id is the idempotency handle (task 5 ruling): the same handle with a
      // byte identical body is a replay of the first order, answered without ever calling
      // place_order again; a different body reusing the same handle falls through to
      // place_order's own duplicate check below, which answers order_rejected with
      // duplicate_client_order_id exactly as it already does for a bare retry. Excludes a
      // rejected order under the same handle (findOrderByClientOrderId, review round 1,
      // finding 1), so a retry after a rejection reaches place_order fresh instead of
      // replaying a failure or being refused against it.
      const clientOrderId = body.client_order_id ?? null;
      const fingerprint = clientOrderId ? fingerprintOf(req.body) : null;
      if (clientOrderId) {
        const existing = await withTx(deps.pool, (c) => X.findOrderByClientOrderId(c, key!.id, clientOrderId));
        if (existing && existing.body_fingerprint === fingerprint) {
          return respondReplayed(deps, res, existing);
        }
      }
      const timeInForce = body.time_in_force ?? (body.type === "market" ? "IOC" : "GTC");
      const now = new Date();
      const orderId = newId("ord");
      const input: X.PlaceOrderInput = {
        keyId: key!.id, market: body.market, clientOrderId,
        side: body.side, type: body.type, timeInForce, postOnly: body.post_only,
        price: body.price ?? null, quantity: body.quantity ?? null, quoteAmount: body.quote_amount ?? null,
      };
      let result: X.PlaceOrderResult;
      try {
        // Review round 1, finding 3: the accept path runs inside ctx.tx, not against the
        // pool directly, so a stored Idempotency-Key reply commits atomically with the
        // order it replays rather than on a separate connection after this transaction
        // already committed (src/platform/route.ts's tx does the storing, inside the same
        // transaction, once placeOrderWithClient resolves). A rejection still rolls this
        // transaction back exactly as it always did; recording it is deliberately not part
        // of it, on its own connection below, since an error reply is never stored.
        result = await tx((c) => X.placeOrderWithClient(c, orderId, input, now, fingerprint));
      } catch (err) {
        const e = err as { message?: string; detail?: string };
        if (e.message === "order_rejected" && e.detail) {
          const rejectionEventIds = await X.recordOrderRejection(deps.pool, input, orderId, e.detail, now);
          if (rejectionEventIds.length > 0) await afterCommit(deps, rejectionEventIds);
          // Review round 1, finding 2: two concurrent placements with the same
          // client_order_id and an identical body can both pass the lookup above before
          // either commits; the loser lands here with duplicate_client_order_id from
          // place_order's own check. Looking the winner up again and comparing fingerprints
          // tells an honest race from a genuinely different order reusing the same handle:
          // a match answers exactly like the plain replay above, 200 with the existing
          // order, rather than surfacing a 422 to a client whose retry only ever lost a
          // timing race against itself.
          if (e.detail === "duplicate_client_order_id" && clientOrderId) {
            const existing = await withTx(deps.pool, (c) => X.findOrderByClientOrderId(c, key!.id, clientOrderId));
            if (existing && existing.body_fingerprint === fingerprint) {
              return respondReplayed(deps, res, existing);
            }
          }
        }
        throw err;
      }
      await afterCommit(deps, result.event_ids);
      return orderOut(result.order);
    },
  }),
  defineRoute({
    method: "delete", path: "/v1/exchange/orders/{id}", summary: "Cancel one order, by id or client_order_id", tag: "Exchange",
    auth: "signed", scope: "exchange:trade", weight: 1, idempotent: true,
    params: OrderIdOrClientOrderIdParam, response: OrderOut,
    handler: async ({ key, params, deps, tx }) => {
      let eventIds: string[] = [];
      const order = await tx(async (c) => {
        const orderId = isId("ord", params.id) ? params.id : (await X.findOrderByClientOrderId(c, key!.id, params.id))?.id;
        if (!orderId) throw notFound("order");
        const r = await X.cancelOrder(c, key!.id, orderId);
        eventIds = r.event_ids;
        return r.order;
      });
      await afterCommit(deps, eventIds);
      return orderOut(order);
    },
  }),
  defineRoute({
    method: "delete", path: "/v1/exchange/orders", summary: "Cancel every open order, optionally for one market", tag: "Exchange",
    auth: "signed", scope: "exchange:trade", weight: 1, idempotent: true,
    query: z.object({ market: MarketSymbol.optional() }), response: OrdersOut,
    handler: async ({ key, query, deps, tx }) => {
      let eventIds: string[] = [];
      const orders = await tx(async (c) => {
        // Every market this transaction will touch is locked up front, in symbol order,
        // exactly the discipline lock_markets itself enforces (spec 10.4 step 7): scoped to
        // one market, that is the one lock cancelOrder's own loop would take anyway; left to
        // every market, the loop below could otherwise take locks in whatever order the
        // orders happen to have been created, not sorted, which is the one thing this
        // codebase never allows two lock takers to disagree on.
        await X.lockMarkets(c, query.market ? [query.market] : X.MARKETS);
        const ids = await X.listOpenOrderIds(c, key!.id, query.market ?? null);
        const out: X.OrderRow[] = [];
        for (const id of ids) {
          const r = await X.cancelOrder(c, key!.id, id);
          eventIds = eventIds.concat(r.event_ids);
          out.push(r.order);
        }
        return out;
      });
      await afterCommit(deps, eventIds);
      return { data: orders.map(orderOut) };
    },
  }),
  defineRoute({
    method: "get", path: "/v1/exchange/orders", summary: "List the caller's orders: open with ?status=open, history otherwise", tag: "Exchange",
    auth: "signed", scope: "exchange:trade",
    // Spec 10.9 prices this endpoint two ways depending on which listing it is; both are
    // this same route, told apart only by the status filter (spec 10.10).
    weight: (req) => (req.query.status === "open" ? 5 : 10),
    query: PageQuery.extend({ status: OrderStatus.optional() }), response: PagedOf(OrderOut),
    handler: async ({ key, query, deps }) => withTx(deps.pool, async (c) => {
      const page = await X.listOrders(c, key!.id, parsePage(query), query.status ?? null);
      return { data: page.data.map(orderOut), next_cursor: page.next_cursor };
    }),
  }),
  defineRoute({
    method: "get", path: "/v1/exchange/orders/{id}", summary: "Read one order", tag: "Exchange",
    auth: "signed", scope: "exchange:trade", weight: 5,
    params: OrderIdParam, response: OrderOut,
    handler: async ({ key, params, deps }) => {
      const order = await withTx(deps.pool, (c) => X.getOrder(c, key!.id, params.id));
      if (!order) throw notFound("order");
      return orderOut(order);
    },
  }),
  defineRoute({
    method: "get", path: "/v1/exchange/trades", summary: "The caller's own trades, as buyer or seller", tag: "Exchange",
    auth: "signed", scope: "exchange:trade", weight: 10,
    query: PageQuery, response: PagedOf(TradeOut),
    handler: async ({ key, query, deps }) => withTx(deps.pool, async (c) => {
      const page = await X.listMyTrades(c, key!.id, parsePage(query));
      return { data: page.data.map(tradeOut), next_cursor: page.next_cursor };
    }),
  }),
];
