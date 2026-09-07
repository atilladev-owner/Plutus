import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";

/**
 * The six clean site paths, each mapped to a file under public/. Task 1 ships only
 * index.html; the rest arrive in task 2, so this test reads the same directory the app
 * itself reads from to decide, per path, whether a 200 or a 404 is the correct answer,
 * rather than hard coding which pages exist yet.
 */
const PAGE_FILES: Record<string, string> = {
  "/": "index.html",
  "/how-it-works": "how-it-works.html",
  "/exchange": "exchange.html",
  "/use-cases": "use-cases.html",
  "/set-up": "set-up.html",
  "/limits": "limits.html",
};

/**
 * The five pages task 2 builds. Checked individually, with the title tag alongside the h1
 * count, on top of the generic six path sweep below.
 */
const TASK_TWO_PAGES = [
  "/how-it-works",
  "/exchange",
  "/use-cases",
  "/set-up",
  "/limits",
];

function h1Count(html: string): number {
  return (html.match(/<h1[\s>]/g) ?? []).length;
}

function hasTitleTag(html: string): boolean {
  return /<title>[^<]+<\/title>/.test(html);
}

describe("landing", () => {
  it("answers / with the home page, exactly one h1", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(h1Count(res.text)).toBe(1);
  });

  it("answers a page that names no file under public/ with the ordinary 404", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/not-a-real-page");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("answers each of the five inner pages with 200 text/html, one h1 and a title tag", async () => {
    const { app } = await makeTestApp();
    for (const route of TASK_TWO_PAGES) {
      const res = await request(app).get(route);
      expect(res.status, `${route} should be 200`).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(h1Count(res.text), `${route} should carry exactly one h1`).toBe(1);
      expect(hasTitleTag(res.text), `${route} should carry a title tag`).toBe(true);
    }
  });

  it("serves every one of the six paths as 200 text/html with one h1 once its file exists, and 404 otherwise", async () => {
    const { app } = await makeTestApp();
    for (const [route, file] of Object.entries(PAGE_FILES)) {
      const built = existsSync(join(process.cwd(), "public", file));
      const res = await request(app).get(route);
      if (built) {
        expect(res.status, `${route} should be 200`).toBe(200);
        expect(res.headers["content-type"]).toContain("text/html");
        expect(h1Count(res.text), `${route} should carry exactly one h1`).toBe(1);
      } else {
        expect(res.status, `${route} should 404, its file is not built yet`).toBe(404);
      }
    }
  });

  it("serves site.css and site.js as static files", async () => {
    const { app } = await makeTestApp();
    const css = await request(app).get("/site.css");
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
    const js = await request(app).get("/site.js");
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toMatch(/javascript/);
  });
});
