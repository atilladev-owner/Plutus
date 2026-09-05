import { z } from "zod";
import { Iso } from "./common.js";
export const EVENT_TYPES = ["transfer.posted", "hold.created", "hold.captured", "hold.released", "hold.expired"] as const;
export const EndpointCreate = z.object({
  url: z.string().url().refine((u) => u.startsWith("https://"), "must be https"),
  events: z.array(z.enum([...EVENT_TYPES, "*"])).min(1).max(10),
});
export const EndpointPatch = z.object({ url: EndpointCreate.shape.url.optional(), events: EndpointCreate.shape.events.optional(), status: z.enum(["active", "disabled"]).optional() });
export const EndpointOut = z.object({ id: z.string(), url: z.string(), events: z.array(z.string()), status: z.enum(["active", "disabled"]), consecutive_failures: z.number().int(), created_at: Iso });
export const EndpointCreated = EndpointOut.extend({ secret: z.string() });
export const DeliveryOut = z.object({ id: z.string(), event_id: z.string(), attempt: z.number().int(), status: z.enum(["pending", "succeeded", "failed", "dead"]), response_status: z.number().int().nullable(), response_excerpt: z.string().nullable(), next_attempt_at: Iso.nullable(), delivered_at: Iso.nullable(), created_at: Iso });
