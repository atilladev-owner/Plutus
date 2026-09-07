import { z } from "zod";
import { renderApiReference } from "@scalar/client-side-rendering";
import type { Express } from "express";
import { defineRoute, ROUTE_REGISTRY } from "../platform/route.js";
import { buildOpenApi } from "../schemas/openapi.js";
import { streamOpenApiPath } from "./exchange-stream.js";
import type { AppDeps } from "../deps.js";

let cached: Record<string, unknown> | null = null;

export const docsRoutes = [
  defineRoute({
    method: "get", path: "/openapi.json", summary: "The OpenAPI 3.1 document, generated from the same schemas that validate requests", tag: "Meta", auth: "none", limit: "none",
    response: z.record(z.string(), z.unknown()),
    handler: async ({ deps }) => {
      cached ??= buildOpenApi(ROUTE_REGISTRY, deps.config.PUBLIC_BASE_URL, { "/v1/exchange/stream": streamOpenApiPath });
      return cached;
    },
  }),
];

/**
 * Scalar navigates its sidebar through the address hash and pushes a history entry per click,
 * so the browser back button walked the sidebar instead of leaving the page. The shell is
 * rendered here rather than through the Express package so this one script can turn hash
 * pushes into replacements before Scalar loads.
 */
const HISTORY_PATCH =
  "<script>(function(){var push=history.pushState.bind(history);history.pushState=function(state,title,url){" +
  "try{var next=new URL(String(url),location.href);if(next.pathname===location.pathname&&next.search===location.search)" +
  "return history.replaceState(state,title,url);}catch(e){}return push(state,title,url);};})();</script>";

/** The same two Google Fonts links every site page carries, docs/superpowers/specs/2026-09-07-plutus-site-design.md "Type". */
const FONT_LINKS =
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;700&family=Nunito:wght@400;600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">';

const SITE_ASSET_LINKS =
  '<link rel="stylesheet" href="/site.css">' +
  '<link rel="icon" type="image/svg+xml" href="/favicon.svg">' +
  '<script src="/site.js"></script>';

/**
 * The same top bar every site page carries (public/index.html and its siblings), copied
 * rather than shared from a template because every one of the six pages already embeds its
 * own copy the same way. Docs is the current page here; every other page carries no
 * aria-current. The theme toggle is the same button site.js already knows how to drive, so
 * clicking it here sets the same data-theme attribute and the same site tokens apply to this
 * bar exactly as they do everywhere else.
 */
const TOPBAR_HTML = `
<a class="skip-link" href="#app">Skip to content</a>
<header class="topbar">
  <div class="topbar-inner">
    <a class="wordmark" href="/">plutus</a>
    <div class="topbar-scroll">
      <nav class="topbar-nav" aria-label="Site">
        <a href="/">Home</a>
        <a href="/how-it-works">How it works</a>
        <a href="/exchange">Exchange</a>
        <a href="/use-cases">Use cases</a>
        <a href="/set-up">Set up</a>
        <a href="/limits">Limits</a>
        <a href="/docs" aria-current="page">Docs</a>
      </nav>
    </div>
    <button type="button" class="theme-toggle" data-theme-toggle aria-label="Theme, currently System. Activate to change it.">
      <svg data-theme-icon="system" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect width="20" height="14" x="2" y="3" rx="2"></rect>
        <line x1="8" x2="16" y1="21" y2="21"></line>
        <line x1="12" x2="12" y1="17" y2="21"></line>
      </svg>
      <svg data-theme-icon="light" hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4"></circle>
        <path d="M12 2v2"></path>
        <path d="M12 20v2"></path>
        <path d="m4.93 4.93 1.41 1.41"></path>
        <path d="m17.66 17.66 1.41 1.41"></path>
        <path d="M2 12h2"></path>
        <path d="M20 12h2"></path>
        <path d="m6.34 17.66-1.41 1.41"></path>
        <path d="m19.07 4.93-1.41 1.41"></path>
      </svg>
      <svg data-theme-icon="dark" hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>
      </svg>
      <span data-role="theme-label">System</span>
    </button>
  </div>
</header>
`;

/**
 * Scalar's own variables, scoped by .light-mode and .dark-mode on its reference root, mapped
 * onto the site tokens (docs/superpowers/specs/2026-09-07-plutus-site-design.md "Tokens").
 * Values are the literal hex tokens rather than a var() lookup into site.css: Scalar decides
 * which of .light-mode or .dark-mode applies from its own state, independently of this page's
 * own data-theme attribute (see the task report for why the two cannot be wired together), so
 * each mode's block has to be correct standing on its own rather than inherit through the
 * cascade. Every pair here reuses a text and ground combination already checked at 4.5:1 or
 * better for both themes in the task report; --scalar-color-3 and --scalar-background-3 fall
 * back to the same muted text and panel surface as -2, since the site's own token set carries
 * only two tiers of each. Fonts are the one pair that is theme invariant, so those alone use a
 * var() lookup into site.css's own font stacks.
 */
const SCALAR_CUSTOM_CSS = `
.light-mode {
  --scalar-color-1: #1F2A24;
  --scalar-color-2: #5D6B63;
  --scalar-color-3: #5D6B63;
  --scalar-color-accent: #1C6E4A;
  --scalar-background-1: #FBFAF7;
  --scalar-background-2: #F1F0EA;
  --scalar-background-3: #F1F0EA;
  --scalar-background-accent: #E4EFE8;
  --scalar-border-color: #DCE1DA;
  --scalar-sidebar-background-1: #F1F0EA;
  --scalar-sidebar-item-hover-color: #1F2A24;
  --scalar-sidebar-item-hover-background: #E4EFE8;
  --scalar-sidebar-item-active-background: #E4EFE8;
  --scalar-sidebar-border-color: #DCE1DA;
  --scalar-sidebar-color-1: #1F2A24;
  --scalar-sidebar-color-2: #5D6B63;
  --scalar-sidebar-color-active: #1C6E4A;
  --scalar-sidebar-search-background: #FBFAF7;
  --scalar-sidebar-search-border-color: #DCE1DA;
  --scalar-sidebar-search-color: #1F2A24;
}
.dark-mode {
  --scalar-color-1: #EEF2EE;
  --scalar-color-2: #93AC9F;
  --scalar-color-3: #93AC9F;
  --scalar-color-accent: #7CC7A0;
  --scalar-background-1: #141915;
  --scalar-background-2: #1B211C;
  --scalar-background-3: #1B211C;
  --scalar-background-accent: #1F3428;
  --scalar-border-color: #2A332C;
  --scalar-sidebar-background-1: #1B211C;
  --scalar-sidebar-item-hover-color: #EEF2EE;
  --scalar-sidebar-item-hover-background: #1F3428;
  --scalar-sidebar-item-active-background: #1F3428;
  --scalar-sidebar-border-color: #2A332C;
  --scalar-sidebar-color-1: #EEF2EE;
  --scalar-sidebar-color-2: #93AC9F;
  --scalar-sidebar-color-active: #7CC7A0;
  --scalar-sidebar-search-background: #141915;
  --scalar-sidebar-search-border-color: #2A332C;
  --scalar-sidebar-search-color: #EEF2EE;
}
.light-mode, .dark-mode {
  --scalar-font: var(--font-body, "Nunito", system-ui, -apple-system, "Segoe UI", sans-serif);
  --scalar-font-code: var(--font-mono, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
:root {
  /* Offsets Scalar's own sticky sidebar and in page anchors for the site top bar inserted
     above its mount point, so neither sits under the other. */
  --scalar-custom-header-height: 64px;
}

/*
  site.css's own body rule paints from the site's data-theme state, which is right for the
  six plain pages but wrong here: Scalar decides light or dark on its own (.light-mode or
  .dark-mode on this same body element), and when the site's explicit toggle disagrees with
  it, painting the page background from the site's tokens while Scalar's own nested content
  still reads its text colour from its own state left ink text on an ink page. Repainted here
  from Scalar's own resolved variables instead, so only .topbar, styled against the site's
  own tokens below, answers to the toggle; the reference content stays internally consistent
  under whichever mode Scalar itself is in.
*/
body {
  background: var(--scalar-background-1) !important;
  color: var(--scalar-color-1) !important;
}

/*
  Nothing fully rounded, atilla-standards 1.1. Confirmed by rendering the live page and
  querying every element for a computed radius at or past half its own height: buttons,
  badges, inputs and the sidebar search already render at 6px under theme "none", Scalar's
  own base CSS rather than the "kepler" theme this replaced. The one genuine capsule left is
  the response content type selector, .selected-content-type, capped here to the site's own
  small radius. The circular dark mode toggle knob and the round "close client" icon button
  are left alone: both are single purpose circular controls, the named exception in 1.1, not
  a pill holding text.
*/
.selected-content-type {
  border-radius: var(--radius-sm, 10px) !important;
}
`;

/** Mounted separately because Scalar is a rendered page, not a route with a schema. */
export function mountDocs(app: Express, _deps: AppDeps): void {
  const html = renderApiReference({
    config: {
      url: "/openapi.json",
      _integration: "express",
      theme: "none",
      withDefaultFonts: false,
      customCss: SCALAR_CUSTOM_CSS,
    },
    pageTitle: "Plutus API",
  })
    .replace("<html>", '<html lang="en">')
    .replace("<head>", "<head>" + FONT_LINKS + SITE_ASSET_LINKS + HISTORY_PATCH)
    .replace("<body>", "<body>" + TOPBAR_HTML);
  app.get("/docs", (_req, res) => { res.type("text/html").send(html); });
}
