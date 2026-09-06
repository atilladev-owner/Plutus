import { z } from "zod";
import { Iso } from "./common.js";
import { assertPublicWebhookUrl } from "../platform/webhook-url.js";

export const EVENT_TYPES = [
  "transfer.posted", "hold.created", "hold.captured", "hold.released", "hold.expired",
  // The order lifecycle events place_order and cancel_order write for the trading key
  // (db/migrations/0013_place_order.sql), so a webhook can subscribe to one of these by
  // name instead of only ever through "*", spec 10.4 step 6.
  "order.accepted", "order.filled", "order.cancelled", "order.rejected",
] as const;

const EndpointFields = z.object({
  url: z.string().url(),
  events: z.array(z.enum([...EVENT_TYPES, "*"])).min(1).max(10),
});
// assertPublicWebhookUrl also rejects a non https scheme, so it replaces the plain
// "starts with https://" check as well as adding the SSRF checks.
export const EndpointCreate = EndpointFields.superRefine((val, ctx) => {
  try {
    assertPublicWebhookUrl(val.url);
  } catch (err) {
    ctx.addIssue({ code: "custom", path: ["url"], message: (err as Error).message });
  }
});
export const EndpointPatch = z.object({ url: EndpointFields.shape.url.optional(), events: EndpointFields.shape.events.optional(), status: z.enum(["active", "disabled"]).optional() });
export const EndpointOut = z.object({ id: z.string(), url: z.string(), events: z.array(z.string()), status: z.enum(["active", "disabled"]), consecutive_failures: z.number().int(), created_at: Iso });
export const EndpointCreated = EndpointOut.extend({ secret: z.string() });
export const DeliveryOut = z.object({ id: z.string(), event_id: z.string(), attempt: z.number().int(), status: z.enum(["pending", "succeeded", "failed", "dead"]), response_status: z.number().int().nullable(), response_excerpt: z.string().nullable(), next_attempt_at: Iso.nullable(), delivered_at: Iso.nullable(), created_at: Iso });
