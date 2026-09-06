import { z } from "zod";
import { defineRoute, parsePage } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { notFound } from "../domain/errors.js";
import { isId } from "../domain/ids.js";
import { stableJson } from "../domain/canonical.js";
import { afterCommit } from "../platform/fanout.js";
import * as X from "../db/exchange.js";
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

const OrderIdParam = z.object({ id: IdParam("ord") });
// Cancel by id accepts a client_order_id too (spec 10.10), so its path segment cannot be
// pinned to the ord_ shape the way every other single order lookup here is.
const OrderIdOrClientOrderIdParam = z.object({ id: z.string().min(1).max(100) });

export const exchangeOrderRoutes = [
  defineRoute({
    method: "post", path: "/v1/exchange/orders", summary: "Place an order", tag: "Exchange",
    auth: "signed", scope: "exchange:trade", weight: 1, placement: true, idempotent: true, status: 201,
    body: OrderCreate, response: OrderOut,
    handler: async ({ key, body, req, res, deps }) => {
      // client_order_id is the idempotency handle (task 5 ruling): the same handle with a
      // byte identical body is a replay of the first order, answered without ever calling
      // place_order again; a different body reusing the same handle falls through to
      // place_order's own duplicate check below, which answers order_rejected with
      // duplicate_client_order_id exactly as it already does for a bare retry.
      const clientOrderId = body.client_order_id ?? null;
      const fingerprint = clientOrderId ? stableJson(req.body ?? null) : null;
      if (clientOrderId) {
        const existing = await withTx(deps.pool, (c) => X.findOrderByClientOrderId(c, key!.id, clientOrderId));
        if (existing && existing.body_fingerprint === fingerprint) {
          res.setHeader("Idempotent-Replayed", "true");
          return orderOut(existing);
        }
      }
      const timeInForce = body.time_in_force ?? (body.type === "market" ? "IOC" : "GTC");
      let result: X.PlaceOrderResult;
      try {
        result = await X.placeOrder(deps.pool, {
          keyId: key!.id, market: body.market, clientOrderId,
          side: body.side, type: body.type, timeInForce, postOnly: body.post_only,
          price: body.price ?? null, quantity: body.quantity ?? null, quoteAmount: body.quote_amount ?? null,
        }, undefined, fingerprint);
      } catch (err) {
        // A rejection's own writes (the market_events row and the trader's own event) land
        // in record_rejection's own transaction, already committed by the time this catches
        // (src/db/exchange.ts's placeOrder); the rejection itself still propagates unchanged
        // for the global error handler to map to 422, but its events still need fanning out.
        const e = err as X.RejectedOrderError;
        if (e.rejectionEventIds && e.rejectionEventIds.length > 0) await afterCommit(deps, e.rejectionEventIds);
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
