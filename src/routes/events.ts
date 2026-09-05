import { z } from "zod";
import { defineRoute, parsePage } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { notFound } from "../domain/errors.js";
import { listEvents, getEvent, type EventRow } from "../db/events.js";
import { IdParam, PagedOf } from "../schemas/common.js";
import { EventOut, EventsQuery } from "../schemas/events.js";

export const eventOut = (e: EventRow) => ({ id: e.id, type: e.type, ledger_id: e.ledger_id, entity_id: e.entity_id, data: e.payload, created_at: e.created_at.toISOString() });

export const eventRoutes = [
  defineRoute({
    method: "get", path: "/v1/events", summary: "Everything that happened, newest first", tag: "Events", auth: "bearer", scope: "ledger:read",
    query: EventsQuery, response: PagedOf(EventOut),
    handler: async ({ deps, key, query }) => withTx(deps.pool, async (c) => {
      const page = await listEvents(c, key!.id, parsePage(query), query.type ?? null);
      return { data: page.data.map(eventOut), next_cursor: page.next_cursor };
    }),
  }),
  defineRoute({
    method: "get", path: "/v1/events/{id}", summary: "Read an event", tag: "Events", auth: "bearer", scope: "ledger:read",
    params: z.object({ id: IdParam("evt") }), response: EventOut,
    handler: async ({ deps, key, params }) => withTx(deps.pool, async (c) => {
      const e = await getEvent(c, key!.id, params.id);
      if (!e) throw notFound("event");
      return eventOut(e);
    }),
  }),
];
