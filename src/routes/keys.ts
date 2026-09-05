import { z } from "zod";
import { defineRoute } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { newId } from "../domain/ids.js";
import { generateSecret } from "../platform/auth.js";
import { insertKey, getKey, rotateKey } from "../db/keys.js";
import { KeyMinted, KeyPublic } from "../schemas/keys.js";
import { notFound } from "../domain/errors.js";

const ALL_SCOPES = ["ledger:read", "ledger:write", "webhooks:manage", "exchange:trade"];

const publicOf = (k: { id: string; mode: "test" | "live"; scopes: string[]; prefix: string; last4: string; created_at: Date; last_used_at: Date | null }) => ({
  id: k.id, mode: k.mode, scopes: k.scopes, prefix: k.prefix, last4: k.last4,
  created_at: k.created_at.toISOString(), last_used_at: k.last_used_at?.toISOString() ?? null,
});

export const keyRoutes = [
  defineRoute({
    method: "post", path: "/v1/keys", summary: "Mint a sandbox key", tag: "Keys", auth: "none", limit: "mint", status: 201,
    response: KeyMinted,
    handler: async ({ deps }) => {
      const s = generateSecret("test");
      const row = await withTx(deps.pool, (c) => insertKey(c, { id: newId("key"), secretHash: s.hash, prefix: s.prefix, last4: s.last4, mode: "test", scopes: ALL_SCOPES }));
      return { ...publicOf(row), secret: s.secret };
    },
  }),
  defineRoute({
    method: "get", path: "/v1/keys/me", summary: "The calling key", tag: "Keys", auth: "bearer",
    response: KeyPublic,
    handler: async ({ deps, key }) => {
      const row = await withTx(deps.pool, (c) => getKey(c, key!.id));
      if (!row) throw notFound("key");
      return publicOf(row);
    },
  }),
  defineRoute({
    method: "post", path: "/v1/keys/rotate", summary: "Rotate the secret. The old one works for fifteen more minutes", tag: "Keys", auth: "bearer", status: 201,
    body: z.object({}).optional(),
    response: KeyMinted,
    handler: async ({ deps, key }) => {
      const s = generateSecret(key!.mode);
      const row = await withTx(deps.pool, async (c) => { await rotateKey(c, key!.id, { secretHash: s.hash, last4: s.last4 }); return getKey(c, key!.id); });
      if (!row) throw notFound("key");
      return { ...publicOf(row), secret: s.secret };
    },
  }),
];
