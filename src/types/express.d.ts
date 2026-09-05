import type { AuthedKey } from "../platform/route.js";

declare global {
  namespace Express {
    interface Locals {
      requestId: string;
      key?: AuthedKey;
      idem?: { keyId: string; idemKey: string; stored: boolean };
    }
  }
}
