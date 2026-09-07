import { z } from "zod";
import { renderApiReference } from "@scalar/client-side-rendering";
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

/**
 * Scalar navigates its sidebar through the address hash and pushes a history entry per click,
 * so the browser back button walked the sidebar instead of leaving the page. The shell is
 * rendered here rather than through the Express package so this one script can turn hash
 * pushes into replacements before Scalar loads.
 */
const HISTORY_PATCH =
  "<script>(function(){var push=history.pushState.bind(history);history.pushState=function(state,title,url){" +
  "try{var next=new URL(String(url),location.href);if(next.pathname===location.pathname&&next.search===location.search)" +
  "return history.replaceState(state,title,url);}catch(e){}return push(state,title,url);};})();</script>";

/** Mounted separately because Scalar is a rendered page, not a route with a schema. */
export function mountDocs(app: Express, _deps: AppDeps): void {
  const html = renderApiReference({ config: { url: "/openapi.json", theme: "kepler", _integration: "express" }, pageTitle: "Plutus API" })
    .replace("<head>", "<head>" + HISTORY_PATCH);
  app.get("/docs", (_req, res) => { res.type("text/html").send(html); });
}
