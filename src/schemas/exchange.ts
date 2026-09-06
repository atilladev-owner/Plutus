import { z } from "zod";
import { AmountString, Iso } from "./common.js";

export const BalanceOut = z.object({ asset: z.string(), balance: z.string(), held: z.string(), available: z.string() });
export const BalancesOut = z.object({ data: z.array(BalanceOut) });

export const MarketSymbol = z.string().regex(/^[A-Z]{3,5}-[A-Z]{3,5}$/, "a BASE-QUOTE market symbol");
export const OrderSide = z.enum(["buy", "sell"]);
export const OrderKind = z.enum(["limit", "market"]);
export const TimeInForce = z.enum(["GTC", "IOC", "FOK"]);
export const OrderStatus = z.enum(["open", "partially_filled", "filled", "cancelled", "rejected"]);
export const ClientOrderId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/, "letters, digits, underscore, dot or hyphen only");

/**
 * The ten order_rejected reasons and the market's own tick, lot and notional rules are
 * the database's to enforce (place_order, db/migrations/0013_place_order.sql); this is only
 * the "structural completeness" the SQL function's own comment says the caller is expected
 * to prevent before a request ever reaches it, so an obviously malformed request never
 * spends a placement point or a round trip to Postgres to be told the shape is wrong.
 */
export const OrderCreate = z.object({
  market: MarketSymbol,
  client_order_id: ClientOrderId.optional(),
  side: OrderSide,
  type: OrderKind,
  time_in_force: TimeInForce.optional(),
  post_only: z.boolean().default(false),
  price: AmountString.optional(),
  quantity: AmountString.optional(),
  quote_amount: AmountString.optional(),
}).superRefine((o, ctx) => {
  if (o.type === "market") {
    if (o.time_in_force !== undefined && o.time_in_force !== "IOC") {
      ctx.addIssue({ code: "custom", path: ["time_in_force"], message: "market orders must be IOC" });
    }
    if (o.post_only) ctx.addIssue({ code: "custom", path: ["post_only"], message: "market orders cannot be post_only" });
    if (o.price !== undefined) ctx.addIssue({ code: "custom", path: ["price"], message: "market orders cannot set a price" });
    if (o.side === "buy") {
      if (o.quote_amount === undefined) ctx.addIssue({ code: "custom", path: ["quote_amount"], message: "a market buy requires quote_amount" });
      if (o.quantity !== undefined) ctx.addIssue({ code: "custom", path: ["quantity"], message: "a market buy sets quote_amount, not quantity" });
    } else {
      if (o.quantity === undefined) ctx.addIssue({ code: "custom", path: ["quantity"], message: "a market sell requires quantity" });
      if (o.quote_amount !== undefined) ctx.addIssue({ code: "custom", path: ["quote_amount"], message: "a market sell sets quantity, not quote_amount" });
    }
  } else {
    if (o.price === undefined) ctx.addIssue({ code: "custom", path: ["price"], message: "limit orders require a price" });
    if (o.quantity === undefined) ctx.addIssue({ code: "custom", path: ["quantity"], message: "limit orders require a quantity" });
    if (o.quote_amount !== undefined) ctx.addIssue({ code: "custom", path: ["quote_amount"], message: "limit orders cannot set quote_amount" });
  }
});

export const OrderOut = z.object({
  id: z.string(), market: z.string(), client_order_id: z.string().nullable(),
  side: OrderSide, type: OrderKind, time_in_force: TimeInForce, post_only: z.boolean(),
  price: z.string().nullable(), quantity: z.string().nullable(), quote_amount: z.string().nullable(),
  filled_quantity: z.string(), filled_quote: z.string(),
  status: OrderStatus, hold_id: z.string().nullable(), accepted_seq: z.string().nullable(),
  reject_reason: z.string().nullable(), created_at: Iso, updated_at: Iso,
});
export const OrdersOut = z.object({ data: z.array(OrderOut) });

export const TradeOut = z.object({
  id: z.string(), market: z.string(), seq: z.string(), buy_order_id: z.string(), sell_order_id: z.string(),
  price: z.string(), quantity: z.string(), notional: z.string(), buyer_fee: z.string(), seller_fee: z.string(),
  transfer_id: z.string(), side: OrderSide, created_at: Iso,
});

/**
 * The public market data shapes, spec 10.6. Distinct from the signed, per key shapes
 * above: a public trade never names the two orders or either fee, only what a public tape
 * shows for the fill itself; a public book level never names an order, only the price
 * aggregate spec 10.6 asks for.
 */
export const MarketOut = z.object({
  symbol: z.string(), base: z.string(), quote: z.string(),
  tick_size: z.string(), lot_size: z.string(), min_notional: z.string(),
  maker_fee_bps: z.number().int(), taker_fee_bps: z.number().int(),
  status: z.enum(["open", "halted"]), seq: z.string(),
  reference_price: z.string().nullable(), house_quoted_at: Iso.nullable(),
});
export const MarketsOut = z.object({ data: z.array(MarketOut) });

export const BookLevelOut = z.object({ price: z.string(), quantity: z.string(), orders: z.string() });
export const BookOut = z.object({ market: z.string(), seq: z.string(), bids: z.array(BookLevelOut), asks: z.array(BookLevelOut) });

export const PublicTradeOut = z.object({
  id: z.string(), market: z.string(), seq: z.string(),
  price: z.string(), quantity: z.string(), notional: z.string(), created_at: Iso,
});
export const PublicTradesOut = z.object({ data: z.array(PublicTradeOut) });

export const TickerOut = z.object({
  market: z.string(), seq: z.string(),
  last: z.string().nullable(), high_24h: z.string().nullable(), low_24h: z.string().nullable(),
  base_volume_24h: z.string().nullable(), quote_volume_24h: z.string().nullable(),
});

export const CandleInterval = z.enum(["1m", "5m", "1h"]);
export const CandleOut = z.object({ t: Iso, open: z.string(), high: z.string(), low: z.string(), close: z.string(), volume: z.string() });
export const CandlesOut = z.object({ data: z.array(CandleOut) });
