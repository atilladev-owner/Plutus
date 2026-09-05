import { z } from "zod";
import { Iso, Metadata } from "./common.js";
export const AccountCreate = z.object({ asset: z.string().regex(/^[A-Z]{3,5}$/), name: z.string().min(1).max(80), metadata: Metadata });
export const AccountOut = z.object({
  id: z.string(), ledger_id: z.string(), asset: z.string(), name: z.string(), kind: z.enum(["normal", "world"]),
  balance: z.string(), held: z.string(), available: z.string(), metadata: z.record(z.string(), z.string()), created_at: Iso,
});
