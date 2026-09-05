import { healthRoutes } from "./health.js";
import { assetRoutes } from "./assets.js";
import { keyRoutes } from "./keys.js";
import { ledgerRoutes } from "./ledgers.js";
import { accountRoutes } from "./accounts.js";
import { transferRoutes } from "./transfers.js";
import { holdRoutes } from "./holds.js";
import { journalRoutes } from "./journal.js";
import { eventRoutes } from "./events.js";

export const allRoutes = [
  ...healthRoutes, ...assetRoutes, ...keyRoutes,
  ...ledgerRoutes, ...accountRoutes, ...transferRoutes, ...holdRoutes, ...journalRoutes, ...eventRoutes,
];
