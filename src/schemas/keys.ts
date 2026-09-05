import { z } from "zod";
import { Iso } from "./common.js";

export const KeyPublic = z.object({
  id: z.string(), mode: z.enum(["test", "live"]), scopes: z.array(z.string()), prefix: z.string(), last4: z.string(),
  created_at: Iso, last_used_at: Iso.nullable(),
});
export const KeyMinted = KeyPublic.extend({ secret: z.string().meta({ description: "Shown exactly once." }) });
export const Asset = z.object({ code: z.string(), name: z.string(), exponent: z.number().int(), kind: z.enum(["fiat", "crypto"]) });
