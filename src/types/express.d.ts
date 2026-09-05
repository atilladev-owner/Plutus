import type { AuthedKey } from "../platform/route.js";

declare global {
  namespace Express {
    interface Locals {
      requestId: string;
      key?: AuthedKey;
      idem?: { keyId: string; idemKey: string; stored: boolean };
    }
    interface Request {
      // Captured by express.json's verify option in app.ts, before the body is parsed
      // into an object: the exact bytes a signature (QStash's on the internal deliver
      // route) was computed over, since re-serialising req.body can disagree with them
      // byte for byte and would make every callback fail to verify.
      rawBody?: Buffer;
    }
  }
}
