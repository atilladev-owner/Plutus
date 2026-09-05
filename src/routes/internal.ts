import { z } from "zod";
import { Receiver } from "@upstash/qstash";
import { defineRoute } from "../platform/route.js";
import { ApiError } from "../domain/errors.js";
import { deliverOnce } from "../platform/deliver.js";

export const internalRoutes = [
  defineRoute({
    method: "post", path: "/internal/webhooks/deliver", summary: "QStash callback that makes one delivery attempt", tag: "Internal", auth: "none", limit: "none",
    body: z.object({ delivery_id: z.string().regex(/^whd_[0-9a-f]{32}$/) }), response: z.object({ ok: z.boolean() }),
    handler: async ({ deps, body, req }) => {
      const { QSTASH_CURRENT_SIGNING_KEY: cur, QSTASH_NEXT_SIGNING_KEY: nxt, CRON_SECRET } = deps.config;
      const internal = req.header("x-plutus-internal");
      if (cur && nxt) {
        const sig = req.header("upstash-signature") ?? "";
        const ok = await new Receiver({ currentSigningKey: cur, nextSigningKey: nxt }).verify({ signature: sig, body: JSON.stringify(req.body), url: `${deps.config.PUBLIC_BASE_URL}/internal/webhooks/deliver` }).catch(() => false);
        if (!ok) throw new ApiError(401, "invalid_signature", "QStash signature did not verify");
      } else if (!CRON_SECRET || internal !== CRON_SECRET) {
        throw new ApiError(401, "unauthorized", "internal route");
      }
      await deliverOnce(deps, body.delivery_id);
      return { ok: true };
    },
  }),
];
