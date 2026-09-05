// The deploy preset picks the first module that imports express itself, so this file does.
import express from "express";
import { createApp } from "./create-app.js";
import { buildProductionDeps } from "./deps.js";
import { allRoutes } from "./routes/index.js";
import { productionMiddleware } from "./platform/middleware.js";
import { initSentry } from "./platform/sentry.js";

const deps = buildProductionDeps();
initSentry(deps.config);
const app: express.Express = createApp(deps, allRoutes, productionMiddleware(deps));
export default app;
