# Plutus site design

The public site for Plutus, rebuilt as a small multi page product site whose home page
shows the exchange working live. Direction chosen by the owner: the live proof desk. Light,
editorial and technical. The API itself is unchanged; only the pages under `public/`, the
routes that serve them, and the styling of the API reference change.

## Reading

A product site for a developer API, read by developers deciding whether to trust it and by
hiring managers judging rigor. The register is quiet confidence: the site shows numbers it
fetched a second ago rather than claiming things. One accent, deep green, kept from the
existing identity. No purple, no gradients as decoration, no glass, no pills, no emoji, no
three equal cards, no serif. Ivory ground because the reference document look is right for
infrastructure; the live panel is where the site earns its personality.

## Tokens

Light, on `:root`:

| Token | Value | Use |
|---|---|---|
| `--ground` | `#FBFAF7` | page background |
| `--panel` | `#F1F0EA` | raised surfaces, code blocks, the live desk |
| `--line` | `#DCE1DA` | hairlines, table rules |
| `--ink` | `#1F2A24` | text |
| `--muted` | `#5D6B63` | secondary text, labels |
| `--accent` | `#1C6E4A` | links, primary action, bids, diagram emphasis |
| `--accent-deep` | `#145238` | hover and active |
| `--accent-wash` | `#E4EFE8` | the tint behind an accent element |
| `--data-1` | `#C9D2CB` | diagram fills only, always inside an outlined shape |
| `--data-2` | `#74857A` | every meaning bearing stroke and connector: the four diagrams, the chart grid |
| `--warn` | `#8A5A2B` | semantic only: a stale or failed live read; never decoration |

Dark, under `prefers-color-scheme: dark` guarded as `:root:not([data-theme="light"])` and
again under `:root[data-theme="dark"]`:

| Token | Value |
|---|---|
| `--ground` | `#141915` |
| `--panel` | `#1B211C` |
| `--line` | `#2A332C` |
| `--ink` | `#EEF2EE` |
| `--muted` | `#93AC9F` |
| `--accent` | `#7CC7A0` |
| `--accent-deep` | `#A3DABB` |
| `--accent-wash` | `#1F3428` |
| `--data-1` | `#2E3A32` |
| `--data-2` | `#5E7365` |
| `--warn` | `#D9A66A` |

Every text and ground pair must compute to at least 4.5:1 in both themes; the builder
writes the numbers in the report. Asks in the book are set in `--ink`, bids in `--accent`,
and both columns carry a text label, so colour never carries the meaning alone. `--data-2`
is a non-text graphical colour, held to 3:1 against both `--ground` and `--panel`; `--data-1`
carries no such floor because it is a fill only, never the shape's own edge.

## Type

Outfit for the wordmark, display and headings, weights 600 and 700, tracking `-0.02em`
above 28px, `text-wrap: balance`. Nunito for body, 400 and 600, line height 1.6, measure
65ch. JetBrains Mono for numbers, code and the live desk, with `font-variant-numeric:
tabular-nums`. Google Fonts links only, with real fallback stacks.

Scale, in px: 14, 16, 18, 22, 28, 36, 48, and a display step `clamp(40px, 6vw, 72px)`.
Body is 16 at every width. Uppercase labels are 13px with `0.08em` tracking and are rare:
at most one eyebrow per three sections, page wide.

## Space and shape

Spacing scale 4, 8, 12, 16, 24, 32, 48, 64, 96. Content width 1120px, gutters 24px on
narrow screens and 40px from 900px. Radius 10px on small elements, 14px on panels, 0 on
tables. Nothing is fully rounded except the status dot in the live desk. Shadows are tinted
toward the ground and used only on the live desk. Hairlines separate sections; cards appear
only where elevation means something.

## Icons and diagrams

Icons are inline SVG from Lucide, 20px, stroke 1.5, `currentColor`, one style, always with
a text label. Diagrams are inline SVG drawn with the tokens above, text in the site's fonts,
a `<title>` and a one sentence text alternative under each. Four diagrams, each the
centrepiece of its section, and each drawn once at 880px wide and scaled by viewBox:

1. A transfer: two accounts, the legs between them, and the journal entry it appends.
2. A hold's life: created, partly captured, closed as captured or released.
3. A match: the incoming order walking the resting side in price then time order, one fill
   becoming one three leg transfer.
4. The chain: entries linked by hashes, and what verify recomputes.

## Pages and layout families

Six pages, six different layout families. Every page shares the top bar (wordmark, five
links, the Docs link, a theme toggle) and the footer (source, licence, verify links). The
top bar is one line at desktop, 64px tall, and collapses to a single row of links that
scrolls horizontally inside its own container below 720px.

1. **Home**, `/`. Split hero: headline and one paragraph on the left, the live proof desk on
   the right as the real visual element. The desk shows the BTC-USDT book five levels a
   side, last price, the verify result, and a status line naming the time of the last read.
   Below: a two column explanation with diagram 1, then the four use cases as an
   asymmetric grid where at least two tiles carry a tinted wash or a small diagram, then a
   set up strip with the first three commands and one button. One h1.
2. **How it works**, `/how-it-works`. Long form with a sticky in page list on the left at
   desktop, the four diagrams in their sections, code blocks for the shapes, and a closing
   section on what the house does. Section links replace the address, never push history.
3. **Exchange**, `/exchange`. Data first: the live book ten levels a side, ticker, the last
   twenty trades, a candles chart drawn as SVG from the candles endpoint, and the stream
   explained with a live counter of events received. A market switcher between BTC-USDT
   and ETH-USDT.
4. **Use cases**, `/use-cases`. Four narratives, each a short story with the API calls that
   story needs and a tiny diagram of its money flow: a savings group, group expenses, a tab,
   a deposit on a reservation.
5. **Set up**, `/set-up`. A numbered sequence, because it is one: mint a key, open a ledger,
   move money, verify; then the exchange: faucet, sign, place, read. Code blocks with a
   copy control that shows "Copied" for two seconds. The signing message spelled out.
6. **Limits and proof**, `/limits`. The two limits tables, the ten rejection reasons, and two
   live verify panels, one for the exchange and one explaining how to run it for a ledger.

## The live desk

A small inline script per page, no framework, no build step. It reads the public endpoints
with `fetch`, renders into reserved space so nothing shifts, and refreshes the book and
ticker every five seconds while the tab is visible, pausing on `visibilitychange`. The
verify call runs once per page load and treats a 429 as "checked recently" rather than an
error. Every read has a loading state shaped like the final layout, an empty state, and a
failed state in `--warn` with the reason. Times are shown relative ("2 seconds ago") and
update each second. Numbers are formatted from minor units with the asset exponent, never
through floats: split the string, do not divide. Reduced motion disables the row
highlight on change.

## Motion

Only `transform` and `opacity`, 180ms `ease-out`, on: link underline, the copy control's
confirmation, a row highlight when a book level changes, the theme toggle. Nothing loops.
`prefers-reduced-motion` collapses all of it to instant. No scroll listeners.

## The API reference

Scalar stays because its try it console is worth keeping. It is restyled, not replaced:
`theme: "none"` plus `customCss` mapping Scalar's variables to the tokens above and the
fonts, a top bar matching the site inserted above it in the shell the docs route already
renders, and the history patch kept. Both themes.

## Serving

Pages are static files under `public/` served by the app through the existing landing
route, generalised to a map of clean paths to files, so `/how-it-works` works on Vercel and
locally the same way. Shared CSS in `public/site.css` and shared script in
`public/site.js`, both served as static files. Each page carries its own `<title>`, one h1,
a description meta, and the two font links.

## Accessibility and quality gates

AA contrast computed and written down for every pair used; visible focus rings; keyboard
reachable everything; skip link; no sideways scroll at 390px; one h1 per page; images and
diagrams with alternatives; the theme toggle works without the script through the system
setting. The impeccable audit runs on the finished pages and its findings are fixed before
the deploy.

## Build plan

Three implementation tasks, one builder at a time, each reviewed:

1. Shell and home: tokens, `site.css`, `site.js`, the top bar and footer, the serving map,
   the home page with the live desk and diagram 1.
2. Inner pages: how it works with diagrams 2 to 4, exchange with the live views and the
   candles chart, use cases, set up, limits and proof.
3. The API reference restyle, the README and guide links updated, the portfolio screenshot.

Then the impeccable audit, one fix pass, and the deploy.
