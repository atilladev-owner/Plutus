import { z } from "zod";
import { MAX_AMOUNT } from "../domain/money.js";

export const AmountString = z.string().regex(/^(0|[1-9][0-9]*)$/, "a decimal string of minor units")
  .refine((s) => BigInt(s) <= MAX_AMOUNT, "exceeds the maximum amount")
  .refine((s) => s !== "0", "must be greater than zero")
  .meta({ description: "Integer minor units as a decimal string. 1 BTC is \"100000000\".", examples: ["1250"] });

export const Metadata = z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/), z.string().max(500))
  .refine((m) => Object.keys(m).length <= 20, "at most 20 keys").default({});

export const IdParam = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{32}$`));
export const AccountRef = z.string().regex(/^(acct_[0-9a-f]{32}|world:[A-Z]{3,5})$/, "an account id or world:ASSET");

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).optional(),
});

export const PagedOf = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), next_cursor: z.string().nullable() });

export const Problem = z.object({
  type: z.string(), title: z.string(), status: z.number(), detail: z.string(), code: z.string(), request_id: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export const Iso = z.string().meta({ description: "ISO 8601 UTC with milliseconds" });
