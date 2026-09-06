import { z } from "zod";
import type { RouteDef } from "../platform/route.js";
import { Problem } from "./common.js";

type Json = Record<string, unknown>;
const schemaOf = (s: z.ZodType): Json => z.toJSONSchema(s, { target: "draft-2020-12", io: "output" }) as Json;
const inputSchemaOf = (s: z.ZodType): Json => z.toJSONSchema(s, { target: "draft-2020-12", io: "input" }) as Json;

function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([a-zA-Z_]+)\}/g)].map((m) => m[1] as string);
}

export function buildOpenApi(routes: RouteDef[], baseUrl: string, extraPaths: Record<string, Record<string, Json>> = {}): Json {
  const paths: Record<string, Record<string, Json>> = {};
  const problem = { description: "Problem details", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } };
  for (const r of routes) {
    if (r.path.startsWith("/internal")) continue;
    const params: Json[] = pathParams(r.path).map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));
    if (r.query) {
      const q = inputSchemaOf(r.query);
      const props = (q.properties ?? {}) as Record<string, Json>;
      const required = new Set((q.required ?? []) as string[]);
      for (const [name, schema] of Object.entries(props)) params.push({ name, in: "query", required: required.has(name), schema });
    }
    const responses: Record<string, Json> = {
      [String(r.status ?? 200)]: r.status === 204 ? { description: "No content" } : { description: "Success", content: { "application/json": { schema: schemaOf(r.response) } } },
      "422": problem, "429": problem,
    };
    if (r.auth === "bearer") { responses["401"] = problem; responses["403"] = problem; }
    if (pathParams(r.path).length > 0) responses["404"] = problem;
    if (r.idempotent) responses["409"] = problem;
    const op: Json = {
      summary: r.summary, tags: [r.tag], operationId: `${r.method}_${r.path.replaceAll(/[^a-zA-Z0-9]+/g, "_")}`,
      parameters: params, responses,
      ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: inputSchemaOf(r.body) } } } } : {}),
      ...(r.auth === "bearer" ? { security: [{ bearer: [] }] } : {}),
    };
    if (r.idempotent) (op.parameters as Json[]).push({ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 255 } });
    paths[r.path] ??= {};
    paths[r.path]![r.method] = op;
  }
  // A route that streams (src/routes/exchange-stream.ts, task 8) carries no defineRoute
  // entry, so ROUTE_REGISTRY never sees it and the loop above cannot generate one; the
  // caller (src/routes/docs.ts) hands its hand written path item in here instead.
  for (const [path, ops] of Object.entries(extraPaths)) {
    paths[path] = { ...(paths[path] ?? {}), ...ops };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Plutus", version: "1.0.0", description: "A multi asset ledger and paper trading exchange API. Amounts are strings of minor units. Every list is cursor paginated. Every error is a problem details document with a stable code." },
    servers: [{ url: baseUrl }],
    tags: ["Meta", "Assets", "Keys", "Ledgers", "Accounts", "Transfers", "Holds", "Journal", "Events", "Webhooks"].map((name) => ({ name })),
    paths,
    components: {
      schemas: { Problem: schemaOf(Problem) },
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "Authorization: Bearer pl_test_... or pl_live_..." } },
    },
  };
}
