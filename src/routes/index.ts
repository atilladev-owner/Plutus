import { healthRoutes } from "./health.js";
import { assetRoutes } from "./assets.js";
import { keyRoutes } from "./keys.js";

export const allRoutes = [...healthRoutes, ...assetRoutes, ...keyRoutes];
