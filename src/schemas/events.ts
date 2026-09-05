import { z } from "zod";
import { Iso, PageQuery } from "./common.js";
export const EventOut = z.object({ id: z.string(), type: z.string(), ledger_id: z.string(), entity_id: z.string(), data: z.record(z.string(), z.unknown()), created_at: Iso });
export const EventsQuery = PageQuery.extend({ type: z.string().max(40).optional() });
