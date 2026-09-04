import { createApp } from "./app.js";
import { buildProductionDeps } from "./deps.js";
import { allRoutes } from "./routes/index.js";
import { productionMiddleware } from "./platform/middleware.js";

const deps = buildProductionDeps();
const app = createApp(deps, allRoutes, productionMiddleware(deps));
export default app;
