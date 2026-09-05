import { z } from "zod";
import { randomBytes } from "node:crypto";
import { defineRoute, parsePage } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { newId } from "../domain/ids.js";
import { ApiError, notFound } from "../domain/errors.js";
import * as W from "../db/webhooks.js";
import { IdParam, PageQuery, PagedOf } from "../schemas/common.js";
import { EndpointCreate, EndpointPatch, EndpointOut, EndpointCreated, DeliveryOut } from "../schemas/webhooks.js";
import { assertPublicWebhookUrl } from "../platform/webhook-url.js";

const endpointOut = (e: W.EndpointRow) => ({ id: e.id, url: e.url, events: e.events, status: e.status, consecutive_failures: e.consecutive_failures, created_at: e.created_at.toISOString() });
const deliveryOut = (d: W.DeliveryRow) => ({ id: d.id, event_id: d.event_id, attempt: d.attempt, status: d.status, response_status: d.response_status, response_excerpt: d.response_excerpt, next_attempt_at: d.next_attempt_at?.toISOString() ?? null, delivered_at: d.delivered_at?.toISOString() ?? null, created_at: d.created_at.toISOString() });
const Params = z.object({ id: IdParam("whe") });

export const webhookRoutes = [
  defineRoute({ method: "post", path: "/v1/webhooks", summary: "Register an endpoint. The secret is shown once", tag: "Webhooks", auth: "bearer", scope: "webhooks:manage", idempotent: true, status: 201,
    body: EndpointCreate, response: EndpointCreated,
    handler: async ({ deps, key, body }) => withTx(deps.pool, async (c) => {
      if (key!.mode === "test" && (await W.countEndpoints(c, key!.id)) >= 5) throw new ApiError(409, "sandbox_limit_reached", "webhook endpoints per key: 5");
      const secret = `whsec_${randomBytes(24).toString("base64url")}`;
      const row = await W.insertEndpoint(c, { id: newId("whe"), keyId: key!.id, url: body.url, secret, events: body.events });
      return { ...endpointOut(row), secret };
    }) }),
  defineRoute({ method: "get", path: "/v1/webhooks", summary: "List endpoints", tag: "Webhooks", auth: "bearer", scope: "webhooks:manage",
    response: z.object({ data: z.array(EndpointOut) }),
    handler: async ({ deps, key }) => withTx(deps.pool, async (c) => ({ data: (await W.listEndpoints(c, key!.id)).map(endpointOut) })) }),
  defineRoute({ method: "get", path: "/v1/webhooks/{id}", summary: "Read an endpoint", tag: "Webhooks", auth: "bearer", scope: "webhooks:manage",
    params: Params, response: EndpointOut,
    handler: async ({ deps, key, params }) => withTx(deps.pool, async (c) => { const e = await W.getEndpoint(c, key!.id, params.id); if (!e) throw notFound("webhook endpoint"); return endpointOut(e); }) }),
  defineRoute({ method: "patch", path: "/v1/webhooks/{id}", summary: "Change an endpoint or re enable it", tag: "Webhooks", auth: "bearer", scope: "webhooks:manage",
    params: Params, body: EndpointPatch, response: EndpointOut,
    // EndpointCreate's superRefine only runs on creation; a URL change here needs the
    // same SSRF check run by hand before it reaches the database.
    handler: async ({ deps, key, params, body }) => {
      if (body.url !== undefined) assertPublicWebhookUrl(body.url);
      return withTx(deps.pool, async (c) => { const e = await W.updateEndpoint(c, key!.id, params.id, body); if (!e) throw notFound("webhook endpoint"); return endpointOut(e); });
    } }),
  defineRoute({ method: "delete", path: "/v1/webhooks/{id}", summary: "Delete an endpoint and its deliveries", tag: "Webhooks", auth: "bearer", scope: "webhooks:manage", status: 204,
    params: Params, response: z.undefined(),
    handler: async ({ deps, key, params, res }) => { const ok = await withTx(deps.pool, (c) => W.deleteEndpoint(c, key!.id, params.id)); if (!ok) throw notFound("webhook endpoint"); res.status(204).end(); return undefined; } }),
  defineRoute({ method: "get", path: "/v1/webhooks/{id}/deliveries", summary: "Deliveries, newest first, dead ones included", tag: "Webhooks", auth: "bearer", scope: "webhooks:manage",
    params: Params, query: PageQuery, response: PagedOf(DeliveryOut),
    handler: async ({ deps, key, params, query }) => withTx(deps.pool, async (c) => {
      if (!(await W.getEndpoint(c, key!.id, params.id))) throw notFound("webhook endpoint");
      const page = await W.listDeliveries(c, params.id, parsePage(query));
      return { data: page.data.map(deliveryOut), next_cursor: page.next_cursor };
    }) }),
  defineRoute({ method: "post", path: "/v1/webhooks/{id}/deliveries/{deliveryId}/retry", summary: "Retry a dead or failed delivery now", tag: "Webhooks", auth: "bearer", scope: "webhooks:manage", status: 202,
    params: Params.extend({ deliveryId: IdParam("whd") }), body: z.object({}).optional(), response: z.object({ scheduled: z.boolean() }),
    handler: async ({ deps, key, params }) => {
      await withTx(deps.pool, async (c) => {
        if (!(await W.getEndpoint(c, key!.id, params.id))) throw notFound("webhook endpoint");
        const d = await W.getDelivery(c, params.deliveryId);
        if (!d || d.endpoint_id !== params.id) throw notFound("delivery");
        await W.recordAttempt(c, d.id, { attempt: 0, status: "pending", responseStatus: null, excerpt: null, nextAttemptAt: new Date() });
      });
      await deps.scheduler.schedule(params.deliveryId, 0);
      return { scheduled: true };
    } }),
];
