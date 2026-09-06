import { healthRoutes } from "./health.js";
import { assetRoutes } from "./assets.js";
import { keyRoutes } from "./keys.js";
import { ledgerRoutes } from "./ledgers.js";
import { accountRoutes } from "./accounts.js";
import { transferRoutes } from "./transfers.js";
import { holdRoutes } from "./holds.js";
import { journalRoutes } from "./journal.js";
import { eventRoutes } from "./events.js";
import { verifyRoutes } from "./verify.js";
import { webhookRoutes } from "./webhooks.js";
import { internalRoutes } from "./internal.js";
import { exchangeWalletRoutes } from "./exchange-wallet.js";
import { docsRoutes } from "./docs.js";

export const allRoutes = [
  ...healthRoutes, ...assetRoutes, ...keyRoutes,
  ...ledgerRoutes, ...accountRoutes, ...transferRoutes, ...holdRoutes, ...journalRoutes, ...eventRoutes, ...verifyRoutes,
  ...webhookRoutes, ...internalRoutes, ...exchangeWalletRoutes, ...docsRoutes,
];
