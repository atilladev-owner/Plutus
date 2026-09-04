import express, { type Express } from "express";
import helmet from "helmet";
import type { AppDeps } from "./deps.js";
import { requestId } from "./platform/request-id.js";
import { requestLog } from "./platform/logger.js";
import { errorHandler, notFoundHandler } from "./platform/error-handler.js";
import { mountRoutes, type RouteDef, type RouteMiddleware } from "./platform/route.js";
import { healthRoutes } from "./routes/health.js";

const passThrough: RouteMiddleware = {
  auth: () => (_req, _res, next) => next(),
  rateLimit: () => (_req, _res, next) => next(),
  idempotency: () => (_req, _res, next) => next(),
};

export function createApp(deps: AppDeps, routes: RouteDef[] = [...healthRoutes], mw: RouteMiddleware = passThrough): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.locals.deps = deps;
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(requestId);
  app.use(requestLog(deps.logger));
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use((req, res, next) => {
    res.setTimeout(30_000, () => {
      if (!res.headersSent) res.status(503).type("application/problem+json").send(JSON.stringify({
        type: "https://plutus.atilladev.com/errors/internal_error", title: "Service Unavailable", status: 503,
        detail: "the request took too long", code: "internal_error", request_id: res.locals.requestId,
      }));
    });
    next();
  });
  app.use(express.static("public"));
  mountRoutes(app, deps, routes, mw);
  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
}
