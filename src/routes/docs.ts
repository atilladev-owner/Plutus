import { z } from "zod";
import { apiReference } from "@scalar/express-api-reference";
import type { Express } from "express";
import { defineRoute, ROUTE_REGISTRY } from "../platform/route.js";
import { buildOpenApi } from "../schemas/openapi.js";
import { streamOpenApiPath } from "./exchange-stream.js";
import type { AppDeps } from "../deps.js";

let cached: Record<string, unknown> | null = null;

export const docsRoutes = [
  defineRoute({
    method: "get", path: "/openapi.json", summary: "The OpenAPI 3.1 document, generated from the same schemas that validate requests", tag: "Meta", auth: "none", limit: "none",
    response: z.record(z.string(), z.unknown()),
    handler: async ({ deps }) => {
      cached ??= buildOpenApi(ROUTE_REGISTRY, deps.config.PUBLIC_BASE_URL, { "/v1/exchange/stream": streamOpenApiPath });
      return cached;
    },
  }),
];

/** Mounted separately because Scalar is Express middleware, not a route with a schema. */
export function mountDocs(app: Express, _deps: AppDeps): void {
  app.use("/docs", apiReference({ url: "/openapi.json", theme: "kepler", pageTitle: "Plutus API" }));
}
