import express, { type Express, type Request, type RequestHandler } from "express";
import * as helmetModule from "helmet";
import type { AppDeps } from "./deps.js";
import { cors } from "./platform/cors.js";
import { requestId } from "./platform/request-id.js";
import { requestLog } from "./platform/logger.js";
import { errorHandler, notFoundHandler } from "./platform/error-handler.js";
import { mountRoutes, type RouteDef, type RouteMiddleware } from "./platform/route.js";
import { healthRoutes } from "./routes/health.js";
import { mountDocs } from "./routes/docs.js";
import { mountLanding } from "./routes/landing.js";
import { mountStream } from "./routes/exchange-stream.js";

type HelmetFactory = (options?: helmetModule.HelmetOptions) => RequestHandler;

/**
 * helmet ships ESM and CommonJS typings and TypeScript resolved a different pair on the
 * deploy host than locally, so the factory is picked at runtime instead of at type level.
 * Node always loads the ESM build, where the default export is the factory itself.
 */
const helmetExport: unknown = helmetModule.default;
const helmet: HelmetFactory =
  typeof helmetExport === "function" ? (helmetExport as HelmetFactory) : (helmetExport as { default: HelmetFactory }).default;

const passThrough: RouteMiddleware = {
  auth: () => (_req, _res, next) => next(),
  rateLimit: () => (_req, _res, next) => next(),
  idempotency: () => (_req, _res, next) => next(),
};

export function createApp(deps: AppDeps, routes: RouteDef[] = [...healthRoutes], mw: RouteMiddleware = passThrough): Express {
  const app = express();
  app.disable("x-powered-by");
  // Exactly one hop: Vercel's edge is the only proxy in front of us. "1" makes Express trust
  // only the address that hop appended to X-Forwarded-For and derive req.ip from it, so a
  // client cannot forge earlier hops (or X-Real-IP) to spoof its own address. `true` would
  // trust every hop a client cares to prepend, which defeats per-IP rate limiting.
  app.set("trust proxy", 1);
  app.locals.deps = deps;
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors);
  app.use(requestId);
  app.use(requestLog(deps.logger));
  app.use(express.json({
    limit: "64kb", strict: true,
    // Keeps the exact bytes the body was sent as, before parsing turns them into an
    // object: the internal deliver route verifies QStash's signature against these
    // bytes, since re-serialising req.body is not guaranteed to match them byte for
    // byte and would make a correctly signed callback fail to verify.
    verify: (req, _res, buf) => { (req as Request).rawBody = buf; },
  }));
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
  // Streams, so it never goes through mountRoutes' own JSON response handling: mounted
  // directly, the same way mountDocs and mountLanding are, task 8.
  mountStream(app, deps);
  mountDocs(app, deps);
  mountLanding(app);
  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
}
