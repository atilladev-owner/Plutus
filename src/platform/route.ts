import type { Express, Request, Response, NextFunction } from "express";
import { z, type ZodType } from "zod";
import type { AppDeps } from "../deps.js";
import { ApiError, validation } from "../domain/errors.js";
import { decodeCursor, type Cursor } from "../domain/cursor.js";
import type { RateBucket } from "./ratelimit.js";

export interface AuthedKey { id: string; mode: "test" | "live"; scopes: string[]; prefix: string; last4: string }
export type Scope = "ledger:read" | "ledger:write" | "webhooks:manage" | "exchange:trade";

export interface RouteContext<P, Q, B> {
  params: P; query: Q; body: B;
  key: AuthedKey | null; requestId: string; ip: string;
  deps: AppDeps; req: Request; res: Response;
}

export interface RouteDef<P = unknown, Q = unknown, B = unknown, R = unknown> {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  summary: string;
  tag: string;
  auth: "none" | "bearer";
  scope?: Scope;
  limit?: RateBucket | "standard" | "none";
  idempotent?: boolean;
  params?: ZodType<P>;
  query?: ZodType<Q>;
  body?: ZodType<B>;
  response: ZodType<R>;
  status?: number;
  // Method shorthand, not a function-typed property: TypeScript checks method signatures
  // bivariantly, which is what lets a RouteDef<P, Q, B, R> with concrete P/Q/B live in a
  // RouteDef[] (== RouteDef<unknown, unknown, unknown, unknown>[]) array. A property typed
  // as an arrow function is checked contravariantly and rejects that assignment.
  handler(ctx: RouteContext<P, Q, B>): Promise<R>;
}

export const ROUTE_REGISTRY: RouteDef[] = [];

export function defineRoute<P, Q, B, R>(def: RouteDef<P, Q, B, R>): RouteDef<P, Q, B, R> {
  return def;
}

/** Middleware slots filled by later tasks. Each is a factory so tests can swap them. */
export interface RouteMiddleware {
  auth: (def: RouteDef) => (req: Request, res: Response, next: NextFunction) => void;
  rateLimit: (def: RouteDef) => (req: Request, res: Response, next: NextFunction) => void;
  idempotency: (def: RouteDef) => (req: Request, res: Response, next: NextFunction) => void;
}

export function toExpressPath(path: string): string {
  return path.replaceAll(/\{([a-zA-Z_]+)\}/g, ":$1");
}

function issuesOf(err: z.ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

export function parsePage(query: { limit: number; cursor?: string }): { limit: number; cursor: Cursor | null } {
  if (query.cursor === undefined) return { limit: query.limit, cursor: null };
  const cursor = decodeCursor(query.cursor);
  if (!cursor) throw validation("cursor is not valid", [{ path: "cursor", message: "not a cursor this API issued" }]);
  return { limit: query.limit, cursor };
}

export function mountRoutes(app: Express, deps: AppDeps, routes: RouteDef[], mw: RouteMiddleware): void {
  for (const def of routes) {
    ROUTE_REGISTRY.push(def);
    const chain = [mw.auth(def), mw.rateLimit(def), mw.idempotency(def)];
    app[def.method](toExpressPath(def.path), ...chain, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const params = def.params ? def.params.safeParse(req.params) : { success: true as const, data: req.params };
        if (!params.success) throw new ApiError(404, "not_found", "no such resource", issuesOf(params.error));
        const query = def.query ? def.query.safeParse(req.query) : { success: true as const, data: req.query };
        if (!query.success) throw validation("query is invalid", issuesOf(query.error));
        let body: unknown = undefined;
        if (def.body) {
          // req.is() reports false, not null, when Content-Length: 0 is present with no
          // Content-Type (many clients send that for a bodyless POST), so it alone cannot
          // tell "no body" from "wrong type with a real body". Content-Length / Transfer-Encoding
          // decide whether a body actually exists; req.is() then decides whether its type is right.
          const hasBody = req.header("transfer-encoding") !== undefined || Number(req.header("content-length") ?? "0") > 0;
          const bodyType = req.is("application/json");
          if (hasBody && bodyType === false) throw new ApiError(415, "unsupported_media_type", "send application/json");
          const parsed = def.body.safeParse(req.body);
          if (!parsed.success) throw validation("the request body is invalid", issuesOf(parsed.error));
          body = parsed.data;
        }
        const out = await def.handler({
          params: params.data as never, query: query.data as never, body: body as never,
          key: (res.locals.key as AuthedKey | undefined) ?? null,
          requestId: res.locals.requestId as string,
          ip: req.ip ?? "0.0.0.0",
          deps, req, res,
        });
        if (res.headersSent) return;
        res.status(res.statusCode !== 200 ? res.statusCode : (def.status ?? 200)).json(out);
      } catch (err) {
        next(err);
      }
    });
  }
}
