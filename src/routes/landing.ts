import { readFileSync } from "node:fs";
import type { Express } from "express";

/**
 * The six site pages are static files under public/. Locally express.static would serve
 * them for a direct file path, but the deploy host only serves public/ for a direct file
 * path too, and none of these are that: a clean path like /how-it-works names no file that
 * literally exists at that path, so the host never routes it to a static asset and the
 * request reaches this app instead. Each page is therefore read once at module load, the
 * same pattern the single page landing route used before this file generalised it, and
 * served from that copy by exact path match. A page not yet built (tasks 2 and 3) is simply
 * missing from the map, and the route falls through to the ordinary 404 handler.
 *
 * File URLs are relative to this module, not to process.cwd(), so the bundler traces each
 * one and ships it.
 */
const PAGE_FILES: Record<string, string> = {
  "/": "index.html",
  "/how-it-works": "how-it-works.html",
  "/exchange": "exchange.html",
  "/use-cases": "use-cases.html",
  "/set-up": "set-up.html",
  "/limits": "limits.html",
};

const pages = new Map<string, string>();
for (const [route, file] of Object.entries(PAGE_FILES)) {
  try {
    pages.set(route, readFileSync(new URL(`../../public/${file}`, import.meta.url), "utf8"));
  } catch {
    // Not built yet; mountLanding below leaves this path unregistered and it 404s normally.
  }
}

export function mountLanding(app: Express): void {
  for (const [route, html] of pages) {
    app.get(route, (_req, res) => { res.type("html").send(html); });
  }
}
