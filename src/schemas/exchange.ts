import { z } from "zod";

export const BalanceOut = z.object({ asset: z.string(), balance: z.string(), held: z.string(), available: z.string() });
export const BalancesOut = z.object({ data: z.array(BalanceOut) });
