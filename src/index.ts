import { createApp } from "./create-app.js";
import { buildProductionDeps } from "./deps.js";
import { allRoutes } from "./routes/index.js";
import { productionMiddleware } from "./platform/middleware.js";
import { initSentry } from "./platform/sentry.js";

const deps = buildProductionDeps();
initSentry(deps.config);
const app = createApp(deps, allRoutes, productionMiddleware(deps));
export default app;
