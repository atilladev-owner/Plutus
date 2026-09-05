import { readFileSync } from "node:fs";
import type { Express } from "express";

/**
 * The landing page is a static file in public/. Locally express.static serves it, but the
 * deploy host ignores express.static and only serves public/ for direct file paths, so the
 * root path is answered here from a copy read once at module load. The file URL is relative
 * to this module so the bundler traces and ships the file.
 */
let page: string | null = null;
try {
  page = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
} catch {
  page = null;
}

export function mountLanding(app: Express): void {
  app.get("/", (_req, res, next) => {
    if (page === null) {
      next();
      return;
    }
    res.type("html").send(page);
  });
}
