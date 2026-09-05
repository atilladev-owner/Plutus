import { z } from "zod";
import { defineRoute } from "../platform/route.js";
import { Asset } from "../schemas/keys.js";

export const assetRoutes = [
  defineRoute({
    method: "get", path: "/v1/assets", summary: "The fixed asset table", tag: "Assets", auth: "none", limit: "none",
    response: z.object({ data: z.array(Asset) }),
    handler: async ({ deps }) => {
      const { rows } = await deps.pool.query<{ code: string; name: string; exponent: number; kind: "fiat" | "crypto" }>("select code, name, exponent, kind from assets order by code");
      return { data: rows };
    },
  }),
];
