# Milestone One, The Ledger: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Plutus ledger API to Vercel: keys, ledgers, accounts, atomic multi leg transfers, holds, a hash chained journal with a public verify endpoint, idempotency, rate limits, signed webhooks with retries, generated OpenAPI docs, and a CI a stranger can watch.

**Architecture:** One Express 5 app in TypeScript exported as a single Vercel Function. Every money write is one Postgres function under row locks, with the journal hash computed inside the database. The application layer validates with zod, enforces auth, limits and idempotency, and generates the OpenAPI document from the same schemas that validate requests. Redis holds rate limit windows, QStash drives webhook retries, a daily cron sweeps.

**Tech Stack:** Node 22 (Vercel) and Node 24 (local), TypeScript 5.9, Express 5.2, zod 4.5, pg 8.23, pino 10, helmet 8, @upstash/ratelimit 2, @upstash/redis 1.38, @upstash/qstash 2.11, @scalar/express-api-reference 0.10, Vitest 4.1, fast-check 4.9, supertest 7.2, embedded-postgres 18.4.0-beta.17, Neon Postgres, Vercel Hobby, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-04-plutus-design.md`. The plan argues from the spec. Read both.

## Global Constraints

Copied from the spec. Every task's requirements include these.

- Money is integer minor units: `BIGINT` in Postgres, `bigint` in TypeScript, decimal strings in JSON. Never a float, never a JSON number in an amount field.
- Every id is `prefix_` followed by 32 lowercase hex characters from 16 random bytes: `key_`, `ldg_`, `acct_`, `tr_`, `hold_`, `whe_`, `whd_`, `evt_`.
- Every write to a ledger locks the ledger row first, then accounts in ascending id order. The application never does read then write on money.
- Canonical JSON: keys sorted bytewise, no whitespace, amounts as strings, timestamps ISO 8601 UTC with milliseconds. Hash is SHA256 of `prev_hash || canonical bytes`. Genesis `prev_hash` is 32 zero bytes. Metadata keys match `^[A-Za-z0-9_.-]{1,40}$` so bytewise and UTF-16 orderings agree.
- Errors are RFC 9457 problem details with a stable `code` and `request_id`. No stack trace, SQL or internal path ever reaches a client.
- No `console.*` in `src`. No `parseFloat`, `toFixed`, `Math.round` or `Math.floor` in `src`. No `any`. No secret shaped string in the tree. These are enforced by `scripts/check-house-rules.mjs`, which runs before lint and typecheck in `npm run build`.
- No emoji, no em dash or en dash, anywhere in the tree except `LICENSE.md`. No hyphen used as sentence punctuation in prose a human reads.
- Every commit is authored `Atilla Dev <owner.atilladev@gmail.com>`. No trailer of any kind. Commit subjects are plain sentences.
- ES modules with `.js` extensions on relative imports, `"type": "module"`, TypeScript `strict` with `noUncheckedIndexedAccess`.
- Rate limits: mint 5 per hour per IP; sandbox keys 60 per minute; live keys 600 per minute; verify 10 per minute per key. Ceilings: 10 ledgers per key, 50 accounts per ledger, 10,000 journal entries per ledger, 5 webhook endpoints per key, 100 open holds per account, 64 KB bodies, metadata 20 keys with 500 character values.
- Webhook retry delays after the immediate attempt: 30s, 2m, 10m, 30m, 1h, 3h, 6h, 12h. Dead after 8 attempts. Endpoint disabled after 50 consecutive failures.

---

## File structure

```
plutus/
  package.json, package-lock.json, tsconfig.json, eslint.config.js, vitest.config.ts
  vercel.json, .gitattributes, .env.example
  .github/workflows/ci.yml
  public/index.html                      landing page (Task 14)
  scripts/
    check-house-rules.mjs                the executable rules (Task 1)
    dev.ts                               local listener (Task 1)
    migrate.ts                           applies db/migrations (Task 3)
    key-live.ts                          mints a live key on the owner's machine (Task 6)
  db/migrations/
    0001_functions.sql                   new_id, fmt_ts, canonical_json (Task 3)
    0002_assets.sql                      assets and seed (Task 3)
    0003_keys.sql                        api_keys (Task 3)
    0004_ledger.sql                      ledgers, accounts, transfers, legs, holds, journal, events (Task 3)
    0005_ledger_functions.sql            resolve_account, append_journal, post_transfer, create_hold, release_hold, expire_holds (Task 4)
    0006_idempotency.sql                 (Task 8)
    0007_webhooks.sql                    (Task 11)
  src/
    index.ts                             default export for Vercel (Task 1)
    app.ts                               createApp(deps) (Task 1, grows)
    config.ts                            env parsing (Task 1)
    deps.ts                              AppDeps type and production wiring (Task 5)
    domain/  money.ts ids.ts canonical.ts cursor.ts errors.ts time.ts   (Task 2)
    db/      pool.ts migrate.ts errors.ts keys.ts ledger.ts idempotency.ts webhooks.ts events.ts
    platform/ request-id.ts logger.ts error-handler.ts route.ts auth.ts ratelimit.ts idempotency.ts webhook-sign.ts scheduler.ts cache.ts
    schemas/ common.ts keys.ts ledgers.ts accounts.ts transfers.ts holds.ts journal.ts events.ts webhooks.ts openapi.ts
    routes/  health.ts keys.ts assets.ts ledgers.ts accounts.ts transfers.ts holds.ts journal.ts verify.ts events.ts webhooks.ts internal.ts docs.ts
  tests/
    setup/global-setup.ts                embedded Postgres or TEST_DATABASE_URL, migrations
    helpers/db.ts helpers/app.ts helpers/keys.ts
    unit/ integration/ property/ contract/
```

---

### Task 1: Scaffold, house rules, CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `.gitattributes`, `.env.example`, `vercel.json`
- Create: `src/config.ts`, `src/app.ts`, `src/index.ts`, `scripts/dev.ts`
- Create: `scripts/check-house-rules.mjs`, `tests/unit/house-rules.test.ts`
- Create: `.github/workflows/ci.yml`
- Modify: `README.md` (status line only)

**Interfaces:**
- Produces: `createApp(): Express` in `src/app.ts` (signature changes to `createApp(deps: AppDeps)` in Task 5). `loadConfig(env: NodeJS.ProcessEnv): Config` in `src/config.ts`. `checkTree(root): Violation[]` exported from the house rules script for its own tests.

- [ ] **Step 1: Create package.json with pinned versions**

```json
{
  "name": "plutus",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch scripts/dev.ts",
    "build": "node scripts/check-house-rules.mjs && eslint . && tsc --noEmit",
    "check": "node scripts/check-house-rules.mjs",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:property": "vitest run tests/property",
    "test:contract": "vitest run tests/contract",
    "migrate": "tsx scripts/migrate.ts",
    "key:live": "tsx scripts/key-live.ts"
  },
  "dependencies": {
    "@scalar/express-api-reference": "0.10.17",
    "@upstash/qstash": "2.11.3",
    "@upstash/ratelimit": "2.0.8",
    "@upstash/redis": "1.38.4",
    "express": "5.2.1",
    "helmet": "8.3.0",
    "pg": "8.23.0",
    "pino": "10.3.1",
    "zod": "4.5.4"
  },
  "devDependencies": {
    "@types/express": "5.0.6",
    "@types/node": "22.20.1",
    "@types/pg": "8.23.1",
    "@types/supertest": "6.0.3",
    "embedded-postgres": "18.4.0-beta.17",
    "eslint": "9.39.5",
    "fast-check": "4.9.0",
    "supertest": "7.2.2",
    "tsx": "4.23.13",
    "typescript": "5.9.3",
    "typescript-eslint": "8.69.0",
    "vitest": "4.1.11"
  }
}
```

Run `npm install`. If `@types/supertest@6.0.3` does not exist, run `npm view @types/supertest version` and pin what it prints. Commit the lockfile.

- [ ] **Step 2: tsconfig, eslint, vitest, gitattributes, vercel.json, env example**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src", "scripts", "tests", "vitest.config.ts", "eslint.config.js"]
}
```

`eslint.config.js`:
```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "dist", "coverage", "public"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
);
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/setup/global-setup.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 180_000,
    fileParallelism: true,
  },
});
```

`.gitattributes`:
```
* text=auto eol=lf
```

`vercel.json`:
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [{ "path": "/internal/sweep", "schedule": "0 3 * * *" }]
}
```

`.env.example`:
```
# Postgres. Neon gives two URLs: the pooled one for the API, the direct one for migrations.
DATABASE_URL=postgres://user:password@ep-example-pooler.us-east-1.aws.neon.tech/plutus?sslmode=require
DATABASE_URL_UNPOOLED=postgres://user:password@ep-example.us-east-1.aws.neon.tech/plutus?sslmode=require

# Upstash Redis. Leave both empty locally and the API uses an in memory limiter and cache.
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Upstash QStash. Leave empty locally and webhook deliveries run in process without retries.
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=

# The deployment's own origin. QStash calls back to it.
PUBLIC_BASE_URL=http://localhost:3000

# Vercel sends this as a bearer token to /internal/sweep. Any random 32 characters.
CRON_SECRET=change-me-to-32-random-characters

# Optional
SENTRY_DSN=
PLUTUS_VERSION=dev
```

- [ ] **Step 3: Config and the first app**

`src/config.ts`:
```ts
import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  QSTASH_TOKEN: z.string().optional(),
  QSTASH_CURRENT_SIGNING_KEY: z.string().optional(),
  QSTASH_NEXT_SIGNING_KEY: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  CRON_SECRET: z.string().min(16).optional(),
  SENTRY_DSN: z.string().optional(),
  PLUTUS_VERSION: z.string().default("dev"),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Config = z.infer<typeof Env>;

/** Parses process.env once. Empty strings count as unset, which is how Vercel and .env files behave. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && v.trim() !== "") cleaned[k] = v;
  }
  const parsed = Env.safeParse(cleaned);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Configuration is invalid or incomplete: ${missing}`);
  }
  return parsed.data;
}
```

`src/app.ts` (first version, replaced in Task 5):
```ts
import express, { type Express } from "express";

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  return app;
}
```

`src/index.ts`:
```ts
import { createApp } from "./app.js";

// Vercel imports this module and serves the default export as one function.
const app = createApp();
export default app;
```

`scripts/dev.ts`:
```ts
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");

const { default: app } = await import("../src/index.js");
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  process.stdout.write(`plutus listening on http://localhost:${port}\n`);
});
```

- [ ] **Step 4: Write the failing house rules test**

`tests/unit/house-rules.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTree } from "../../scripts/check-house-rules.mjs";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "plutus-rules-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  writeFileSync(join(root, "package-lock.json"), "{}");
  return root;
}

describe("house rules", () => {
  it("flags console in src", () => {
    const root = tree({ "src/a.ts": 'console.log("x");\n' });
    expect(checkTree(root).map((v) => v.rule)).toContain("no-console");
  });
  it("flags float arithmetic helpers in src", () => {
    const root = tree({ "src/a.ts": "const x = parseFloat('1');\nconst y = (2).toFixed(2);\n" });
    const rules = checkTree(root).map((v) => v.rule);
    expect(rules.filter((r) => r === "no-float-money")).toHaveLength(2);
  });
  it("flags any", () => {
    const root = tree({ "src/a.ts": "let x: any = 1; const y = x as any;\n" });
    expect(checkTree(root).map((v) => v.rule)).toContain("no-any");
  });
  it("flags a secret shaped string anywhere but the example env", () => {
    const root = tree({
      "src/a.ts": 'const t = "pl_live_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";\n',
      ".env.example": "X=pl_live_example\n",
    });
    const hits = checkTree(root).filter((v) => v.rule === "no-secrets");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.file).toBe("src/a.ts");
  });
  it("flags em dashes and emoji outside LICENSE.md", () => {
    const root = tree({ "docs/x.md": "a \u2014 b\n", "LICENSE.md": "a \u2014 b\n", "src/b.ts": '// \u{1F600}\n' });
    const rules = checkTree(root).map((v) => `${v.rule}:${v.file}`);
    expect(rules).toContain("no-dashes:docs/x.md");
    expect(rules).toContain("no-emoji:src/b.ts");
    expect(rules).not.toContain("no-dashes:LICENSE.md");
  });
  it("fails loud when the lockfile is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "plutus-rules-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    expect(checkTree(root).map((v) => v.rule)).toContain("lockfile-present");
  });
  it("passes a clean tree", () => {
    const root = tree({ "src/a.ts": "export const a = 1n;\n" });
    expect(checkTree(root)).toEqual([]);
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `npx vitest run tests/unit/house-rules.test.ts`
Expected: FAIL, cannot find module `../../scripts/check-house-rules.mjs`. (The global setup file does not exist yet either; create an empty `tests/setup/global-setup.ts` exporting `export default async function () {}` so vitest starts. Task 3 replaces it.)

- [ ] **Step 6: Write the checker**

`scripts/check-house-rules.mjs`:
```js
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".vercel", ".superpowers", ".impeccable"]);
const TEXT_EXT = new Set([".ts", ".mts", ".js", ".mjs", ".json", ".md", ".sql", ".yml", ".yaml", ".html", ".css"]);

const EMOJI = /(?!\u00A9|\u00AE|\u2122)\p{Extended_Pictographic}/u;
const DASHES = /[\u2013\u2014]/;
const CONSOLE = /\bconsole\.[a-z]+\(/;
const FLOAT = /\b(parseFloat|toFixed|Math\.round|Math\.floor|Math\.ceil)\b/;
const ANY = /(:\s*any\b|\bas\s+any\b)/;
const SECRETS = [
  /\bpl_(live|test)_[A-Za-z0-9]{32,}/,
  /\bsbp_[a-f0-9]{40}/,
  /\bsk_(live|test)_[A-Za-z0-9]{16,}/,
  /\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}/,
  /postgres(ql)?:\/\/[^:\s]+:[^@\s]{8,}@/,
];

function walk(root, dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(root, full, out);
    else if (TEXT_EXT.has(extname(name)) || name.startsWith(".env")) out.push(full);
  }
}

/** Returns every violation in the tree at root. Exported so the checker can test itself. */
export function checkTree(root) {
  const files = [];
  walk(root, root, files);
  const violations = [];
  if (!existsSync(join(root, "package-lock.json"))) {
    violations.push({ rule: "lockfile-present", file: "package-lock.json", line: 0, excerpt: "missing" });
  }
  for (const full of files) {
    const file = relative(root, full).split("\\").join("/");
    const text = readFileSync(full, "utf8");
    const inSrc = file.startsWith("src/");
    const isLicence = file === "LICENSE.md";
    const isEnvExample = file === ".env.example";
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const at = { file, line: i + 1, excerpt: line.trim().slice(0, 100) };
      if (!isLicence && DASHES.test(line)) violations.push({ rule: "no-dashes", ...at });
      if (!isLicence && EMOJI.test(line)) violations.push({ rule: "no-emoji", ...at });
      if (inSrc && CONSOLE.test(line)) violations.push({ rule: "no-console", ...at });
      if (inSrc && FLOAT.test(line)) violations.push({ rule: "no-float-money", ...at });
      if (inSrc && ANY.test(line)) violations.push({ rule: "no-any", ...at });
      if (!isEnvExample && SECRETS.some((re) => re.test(line))) violations.push({ rule: "no-secrets", ...at });
    });
  }
  return violations;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = process.cwd();
  const violations = checkTree(root);
  const scanned = [];
  walk(root, root, scanned);
  if (scanned.length < 10) {
    process.stderr.write(`House rules: only ${scanned.length} files found under ${root}. Wrong directory?\n`);
    process.exit(1);
  }
  if (violations.length > 0) {
    for (const v of violations) process.stderr.write(`${v.rule}  ${v.file}:${v.line}  ${v.excerpt}\n`);
    process.stderr.write(`House rules failed: ${violations.length} violation(s).\n`);
    process.exit(1);
  }
  process.stdout.write(`House rules pass. ${scanned.length} files checked.\n`);
}
```

Note `FLOAT` includes `Math.ceil`: fee rounding in milestone two is done in `bigint` arithmetic, never through `Math`. `.env` files are scanned so a real secret in `.env.local` fails the check; that file is gitignored but the rule still bites locally, which is the point.

- [ ] **Step 7: Run the tests and the checker**

Run: `npx vitest run tests/unit/house-rules.test.ts` then `npm run check` then `npm run build`
Expected: 7 tests pass; `House rules pass. N files checked.`; eslint clean; tsc clean. If `Math.ceil` in the excerpt of the test file trips the rule, it will not: the rule applies to `src/` only.

- [ ] **Step 8: CI**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18
        env:
          POSTGRES_USER: plutus
          POSTGRES_PASSWORD: plutus
          POSTGRES_DB: plutus_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U plutus"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      TEST_DATABASE_URL: postgres://plutus:plutus@localhost:5432/plutus_test
      CI: "1"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run check
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test:unit
      - run: npm run test:integration
      - run: npm run test:property
      - run: npm run test:contract
  deploy:
    needs: test
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run migrate
        env:
          DATABASE_URL_UNPOOLED: ${{ secrets.DATABASE_URL_UNPOOLED }}
      - run: npx vercel@latest deploy --prod --yes --token=${{ secrets.VERCEL_TOKEN }}
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
```

The `deploy` job will fail until Task 14 adds the secrets. That is expected and visible, not hidden.

- [ ] **Step 9: README status line and commit**

Change the README status paragraph to: `Building milestone one, the ledger. The plan is at docs/superpowers/plans/2026-09-04-milestone-one-the-ledger.md.`

```bash
git add -A
git commit -m "Scaffold the app, the house rules and the CI"
```

---

### Task 2: Domain primitives

**Files:**
- Create: `src/domain/money.ts`, `src/domain/ids.ts`, `src/domain/canonical.ts`, `src/domain/cursor.ts`, `src/domain/errors.ts`, `src/domain/time.ts`
- Test: `tests/unit/money.test.ts`, `tests/unit/ids.test.ts`, `tests/unit/canonical.test.ts`, `tests/unit/cursor.test.ts`, `tests/unit/errors.test.ts`

**Interfaces:**
- Produces: `parseAmount(s: string, opts?: { allowZero?: boolean }): bigint`, `formatAmount(n: bigint): string`, `toDisplay(n: bigint, exponent: number): string`, `MAX_AMOUNT: bigint`, `AmountError`.
- Produces: `newId(prefix: IdPrefix): string`, `isId(prefix: IdPrefix, s: string): boolean`, `type IdPrefix = "key" | "ldg" | "acct" | "tr" | "hold" | "whe" | "whd" | "evt"`.
- Produces: `canonicalJson(value: JsonValue): string`, `hashEntry(prevHash: Buffer, canonical: string): Buffer`, `GENESIS_HASH: Buffer`, `type JsonValue`.
- Produces: `encodeCursor(c: Cursor): string`, `decodeCursor(s: string): Cursor | null`, `type Cursor = { t: string; id: string }`.
- Produces: `class ApiError extends Error { status: number; code: ErrorCode; detail: string; errors?: FieldError[] }`, `type ErrorCode`, helpers `notFound(what)`, `validation(detail, errors?)`.
- Produces: `nowIso(): string`, `toIso(d: Date): string`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/money.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseAmount, formatAmount, toDisplay, MAX_AMOUNT, AmountError } from "../../src/domain/money.js";

describe("parseAmount", () => {
  it("accepts a decimal string of minor units", () => {
    expect(parseAmount("100000000")).toBe(100000000n);
    expect(parseAmount("1")).toBe(1n);
  });
  it("rejects zero unless allowed", () => {
    expect(() => parseAmount("0")).toThrow(AmountError);
    expect(parseAmount("0", { allowZero: true })).toBe(0n);
  });
  it("rejects anything that is not a plain integer string", () => {
    for (const bad of ["", "-1", "1.5", "01", "1e3", " 1", "1 ", "abc", "1_000", "+1"]) {
      expect(() => parseAmount(bad), bad).toThrow(AmountError);
    }
  });
  it("rejects values above BIGINT", () => {
    expect(parseAmount(MAX_AMOUNT.toString())).toBe(MAX_AMOUNT);
    expect(() => parseAmount((MAX_AMOUNT + 1n).toString())).toThrow(AmountError);
  });
  it("formats and displays", () => {
    expect(formatAmount(1250n)).toBe("1250");
    expect(toDisplay(1250n, 2)).toBe("12.50");
    expect(toDisplay(5n, 2)).toBe("0.05");
    expect(toDisplay(100000000n, 8)).toBe("1.00000000");
    expect(toDisplay(7n, 0)).toBe("7");
  });
});
```

`tests/unit/ids.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { newId, isId } from "../../src/domain/ids.js";

describe("ids", () => {
  it("makes prefixed 32 hex ids that never repeat", () => {
    const a = newId("ldg");
    const b = newId("ldg");
    expect(a).toMatch(/^ldg_[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
  it("recognises its own shape and nothing else", () => {
    expect(isId("acct", newId("acct"))).toBe(true);
    expect(isId("acct", newId("ldg"))).toBe(false);
    expect(isId("acct", "acct_short")).toBe(false);
    expect(isId("acct", "acct_" + "G".repeat(32))).toBe(false);
  });
});
```

`tests/unit/canonical.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { canonicalJson, hashEntry, GENESIS_HASH } from "../../src/domain/canonical.js";

describe("canonicalJson", () => {
  it("sorts keys bytewise and strips whitespace, recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: "x", c: [true, null] } })).toBe('{"a":{"c":[true,null],"d":"x"},"b":1}');
  });
  it("escapes strings the way JSON does", () => {
    expect(canonicalJson({ s: 'q"\\\n\t\u0001' })).toBe('{"s":"q\\"\\\\\\n\\t\\u0001"}');
  });
  it("refuses non integer numbers", () => {
    expect(() => canonicalJson({ x: 1.5 })).toThrow();
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });
  it("keeps non ascii as is", () => {
    expect(canonicalJson({ s: "cedi \u20B5" })).toBe('{"s":"cedi \u20B5"}');
  });
});

describe("hashEntry", () => {
  it("matches a fixed vector", () => {
    // sha256(32 zero bytes || '{"a":1}') computed once by hand with node's crypto and pinned.
    const h = hashEntry(GENESIS_HASH, '{"a":1}');
    expect(h.toString("hex")).toBe("VECTOR_PINNED_IN_STEP_3");
  });
  it("chains", () => {
    const h1 = hashEntry(GENESIS_HASH, '{"seq":1}');
    const h2 = hashEntry(h1, '{"seq":2}');
    expect(h2.equals(hashEntry(GENESIS_HASH, '{"seq":2}'))).toBe(false);
  });
});
```

`tests/unit/cursor.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "../../src/domain/cursor.js";

describe("cursor", () => {
  it("round trips", () => {
    const c = { t: "2026-09-04T10:00:00.000Z", id: "ldg_" + "a".repeat(32) };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
  it("is opaque and rejects garbage", () => {
    expect(encodeCursor({ t: "x", id: "y" })).not.toContain("{");
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(Buffer.from('{"t":1}').toString("base64url"))).toBeNull();
  });
});
```

`tests/unit/errors.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ApiError, notFound, validation } from "../../src/domain/errors.js";

describe("ApiError", () => {
  it("carries status, code and detail", () => {
    const e = new ApiError(409, "insufficient_funds", "leg 0 available 5");
    expect(e.status).toBe(409);
    expect(e.code).toBe("insufficient_funds");
    expect(e.message).toBe("leg 0 available 5");
  });
  it("has helpers", () => {
    expect(notFound("ledger").status).toBe(404);
    const v = validation("bad", [{ path: "legs.0.amount", message: "must be a minor unit string" }]);
    expect(v.status).toBe(422);
    expect(v.errors?.[0]?.path).toBe("legs.0.amount");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/unit`
Expected: every new file fails on a missing module.

- [ ] **Step 3: Implement**

`src/domain/money.ts`:
```ts
export const MAX_AMOUNT = 9223372036854775807n;
const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;

export class AmountError extends Error {
  override name = "AmountError";
}

export function parseAmount(s: string, opts: { allowZero?: boolean } = {}): bigint {
  if (typeof s !== "string" || !AMOUNT_RE.test(s)) throw new AmountError("amount must be a decimal string of minor units");
  const n = BigInt(s);
  if (n > MAX_AMOUNT) throw new AmountError("amount exceeds the maximum");
  if (n === 0n && !opts.allowZero) throw new AmountError("amount must be greater than zero");
  return n;
}

export function formatAmount(n: bigint): string {
  return n.toString();
}

/** Human display only. Never fed back into arithmetic. */
export function toDisplay(n: bigint, exponent: number): string {
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const frac = digits.slice(digits.length - exponent);
  return `${negative ? "-" : ""}${whole}${exponent > 0 ? "." + frac : ""}`;
}
```

`src/domain/ids.ts`:
```ts
import { randomBytes } from "node:crypto";

export type IdPrefix = "key" | "ldg" | "acct" | "tr" | "hold" | "whe" | "whd" | "evt";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export function isId(prefix: IdPrefix, s: string): boolean {
  return new RegExp(`^${prefix}_[0-9a-f]{32}$`).test(s);
}
```

`src/domain/canonical.ts`:
```ts
import { createHash } from "node:crypto";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const GENESIS_HASH: Buffer = Buffer.alloc(32, 0);

/**
 * Keys sorted by UTF-16 code unit, which equals bytewise UTF-8 order for the
 * ASCII keys this system permits. Mirrors canonical_json() in the database;
 * both are pinned to the same vectors in tests.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("canonical JSON permits only integer numbers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as JsonValue)}`).join(",")}}`;
}

export function hashEntry(prevHash: Buffer, canonical: string): Buffer {
  return createHash("sha256").update(prevHash).update(Buffer.from(canonical, "utf8")).digest();
}
```

Pin the vector: run `node -e "const {createHash}=require('crypto');console.log(createHash('sha256').update(Buffer.alloc(32)).update('{\"a\":1}').digest('hex'))"` and paste the output over `VECTOR_PINNED_IN_STEP_3` in the test. This same vector is reused by the SQL test in Task 4.

`src/domain/cursor.ts`:
```ts
export interface Cursor { t: string; id: string }

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.t, c.id]), "utf8").toString("base64url");
}

export function decodeCursor(s: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [t, id] = parsed as unknown[];
    if (typeof t !== "string" || typeof id !== "string") return null;
    return { t, id };
  } catch {
    return null;
  }
}
```

`src/domain/errors.ts`:
```ts
export type ErrorCode =
  | "validation_failed" | "unauthorized" | "forbidden_scope" | "not_found"
  | "insufficient_funds" | "asset_mismatch" | "hold_not_open"
  | "idempotency_key_reused" | "idempotency_in_flight" | "rate_limited"
  | "sandbox_limit_reached" | "rate_limiter_unavailable"
  | "invalid_signature" | "timestamp_out_of_window" | "order_rejected"
  | "unsupported_media_type" | "payload_too_large" | "internal_error";

export interface FieldError { path: string; message: string }

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    detail: string,
    public readonly errors?: FieldError[],
    public readonly headers?: Record<string, string>,
  ) {
    super(detail);
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
export const validation = (detail: string, errors?: FieldError[]) => new ApiError(422, "validation_failed", detail, errors);
export const unauthorized = (detail = "a valid API key is required") => new ApiError(401, "unauthorized", detail);
```

`src/domain/time.ts`:
```ts
export const nowIso = (): string => new Date().toISOString();
export const toIso = (d: Date): string => d.toISOString();
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/unit` then `npm run build`
Expected: all pass, checker clean, lint clean, tsc clean.

```bash
git add -A
git commit -m "Domain primitives: amounts, ids, canonical JSON and hashing, cursors, errors"
```

---

### Task 3: Database: pool, migrations runner, schema, and the test database

**Files:**
- Create: `src/db/pool.ts`, `src/db/migrate.ts`, `scripts/migrate.ts`
- Create: `db/migrations/0001_functions.sql`, `0002_assets.sql`, `0003_keys.sql`, `0004_ledger.sql`
- Create: `tests/setup/global-setup.ts` (replace the stub), `tests/helpers/db.ts`
- Test: `tests/integration/migrations.test.ts`, `tests/integration/canonical-sql.test.ts`

**Interfaces:**
- Produces: `createPool(url: string): Pool`, `withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T>` in `src/db/pool.ts`.
- Produces: `runMigrations(connectionString: string, dir?: string): Promise<string[]>` in `src/db/migrate.ts` returning applied file names.
- Produces: `testPool(): Pool` and `testDatabaseUrl(): string` in `tests/helpers/db.ts`.
- Produces in SQL: `new_id(prefix text) returns text`, `fmt_ts(timestamptz) returns text`, `canonical_json(jsonb) returns text`, tables `assets`, `api_keys`, `ledgers`, `accounts`, `transfers`, `transfer_legs`, `holds`, `journal`, `events`.

- [ ] **Step 1: Migrations runner and pool**

`src/db/pool.ts`:
```ts
import pg from "pg";

const { Pool, types } = pg;
// int8 arrives as a string, never a number. BIGINT never touches a float.
types.setTypeParser(20, (v: string) => v);

export type { Pool, PoolClient } from "pg";

export function createPool(connectionString: string): pg.Pool {
  return new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 25_000,
  });
}

export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    try { await client.query("rollback"); } catch { /* the connection is already broken */ }
    throw err;
  } finally {
    client.release();
  }
}
```

`src/db/migrate.ts`:
```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export async function runMigrations(connectionString: string, dir = join(process.cwd(), "db", "migrations")): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    // One writer at a time, so CI and a laptop cannot race each other.
    await client.query("select pg_advisory_lock(7245100)");
    const done = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations(name) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    await client.query("select pg_advisory_unlock(7245100)");
  } finally {
    await client.end();
  }
  return applied;
}
```

`scripts/migrate.ts`:
```ts
import { existsSync } from "node:fs";
import { runMigrations } from "../src/db/migrate.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL_UNPOOLED or DATABASE_URL is required\n");
  process.exit(1);
}
const applied = await runMigrations(url);
process.stdout.write(applied.length ? `applied: ${applied.join(", ")}\n` : "nothing to apply\n");
```

- [ ] **Step 2: The schema**

`db/migrations/0001_functions.sql`:
```sql
create or replace function new_id(prefix text) returns text
language sql volatile as $$
  select prefix || '_' || replace(gen_random_uuid()::text, '-', '')
$$;

create or replace function fmt_ts(ts timestamptz) returns text
language sql immutable as $$
  select to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- Mirrors canonicalJson() in src/domain/canonical.ts. Keys bytewise, no
-- whitespace, strings escaped as JSON, integers only. Both sides are pinned
-- to the same test vectors.
create or replace function canonical_json(j jsonb) returns text
language plpgsql immutable as $$
declare
  t text := jsonb_typeof(j);
  parts text[] := '{}';
  k text;
  v jsonb;
begin
  if t = 'object' then
    for k, v in select key, value from jsonb_each(j) order by key collate "C" loop
      parts := parts || (to_json(k)::text || ':' || canonical_json(v));
    end loop;
    return '{' || array_to_string(parts, ',') || '}';
  elsif t = 'array' then
    for v in select value from jsonb_array_elements(j) loop
      parts := parts || canonical_json(v);
    end loop;
    return '[' || array_to_string(parts, ',') || ']';
  elsif t = 'string' then
    return to_json(j #>> '{}')::text;
  elsif t = 'number' then
    if (j::text) ~ '[.eE]' then
      raise exception 'canonical_json permits only integer numbers';
    end if;
    return j::text;
  elsif t = 'boolean' then
    return j::text;
  else
    return 'null';
  end if;
end $$;
```

`db/migrations/0002_assets.sql`:
```sql
create table assets (
  code text primary key,
  name text not null,
  exponent int not null check (exponent between 0 and 18),
  kind text not null check (kind in ('fiat', 'crypto'))
);

insert into assets (code, name, exponent, kind) values
  ('GHS', 'Ghana cedi', 2, 'fiat'),
  ('HKD', 'Hong Kong dollar', 2, 'fiat'),
  ('USD', 'US dollar', 2, 'fiat'),
  ('USDT', 'Tether', 6, 'crypto'),
  ('BTC', 'Bitcoin', 8, 'crypto'),
  ('ETH', 'Ether', 8, 'crypto');
```

`db/migrations/0003_keys.sql`:
```sql
create table api_keys (
  id text primary key,
  secret_hash bytea not null unique,
  prefix text not null,
  last4 text not null,
  mode text not null check (mode in ('test', 'live')),
  scopes text[] not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  rotated_to text references api_keys(id),
  expires_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_idle_idx on api_keys (mode, last_used_at);
```

`db/migrations/0004_ledger.sql`:
```sql
create table ledgers (
  id text primary key,
  key_id text not null references api_keys(id) on delete cascade,
  name text not null,
  next_seq bigint not null default 1,
  head_hash bytea not null default decode(repeat('00', 32), 'hex'),
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index ledgers_key_idx on ledgers (key_id, created_at desc, id);

create table accounts (
  id text primary key,
  ledger_id text not null references ledgers(id) on delete cascade,
  asset text not null references assets(code),
  name text not null,
  kind text not null check (kind in ('normal', 'world')),
  balance bigint not null default 0,
  held bigint not null default 0 check (held >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Defence in depth. The functions check this too; the constraint makes a bug loud instead of silent.
  check (kind = 'world' or balance - held >= 0)
);
create unique index accounts_world_idx on accounts (ledger_id, asset) where kind = 'world';
create index accounts_ledger_idx on accounts (ledger_id, created_at desc, id);

create table transfers (
  id text primary key,
  ledger_id text not null references ledgers(id) on delete cascade,
  seq bigint not null default 0,
  memo text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index transfers_ledger_idx on transfers (ledger_id, created_at desc, id);

create table holds (
  id text primary key,
  ledger_id text not null references ledgers(id) on delete cascade,
  account_id text not null references accounts(id),
  asset text not null references assets(code),
  amount bigint not null check (amount > 0),
  remaining bigint not null check (remaining >= 0),
  status text not null check (status in ('open', 'captured', 'released', 'expired')),
  expires_at timestamptz not null,
  memo text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index holds_open_account_idx on holds (account_id) where status = 'open';
create index holds_open_expiry_idx on holds (expires_at) where status = 'open';
create index holds_ledger_idx on holds (ledger_id, created_at desc, id);

create table transfer_legs (
  transfer_id text not null references transfers(id) on delete cascade,
  position int not null,
  from_account text not null references accounts(id),
  from_hold text references holds(id),
  to_account text not null references accounts(id),
  asset text not null references assets(code),
  amount bigint not null check (amount > 0),
  primary key (transfer_id, position)
);
create index transfer_legs_from_idx on transfer_legs (from_account);
create index transfer_legs_to_idx on transfer_legs (to_account);

create table journal (
  ledger_id text not null references ledgers(id) on delete cascade,
  seq bigint not null,
  kind text not null,
  entity_id text not null,
  payload jsonb not null,
  prev_hash bytea not null,
  hash bytea not null,
  created_at timestamptz not null,
  primary key (ledger_id, seq)
);

create table events (
  id text primary key,
  key_id text not null references api_keys(id) on delete cascade,
  ledger_id text not null references ledgers(id) on delete cascade,
  type text not null,
  entity_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index events_key_idx on events (key_id, created_at desc, id);
create index events_created_idx on events (created_at);
```

- [ ] **Step 3: The test database**

`tests/setup/global-setup.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../src/db/migrate.js";

// A real Postgres for every test run. TEST_DATABASE_URL wins (CI uses a
// service container). Otherwise embedded-postgres starts one in a temp dir.
export default async function setup(): Promise<() => Promise<void>> {
  let url = process.env.TEST_DATABASE_URL;
  let stop: () => Promise<void> = async () => {};
  if (!url) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const dir = mkdtempSync(join(tmpdir(), "plutus-pg-"));
    const port = 54_300 + Math.trunc(Math.random() * 500);
    const pg = new EmbeddedPostgres({
      databaseDir: dir,
      user: "plutus",
      password: "plutus",
      port,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("plutus_test");
    url = `postgres://plutus:plutus@localhost:${port}/plutus_test`;
    stop = async () => { await pg.stop(); };
  }
  process.env.TEST_DATABASE_URL = url;
  await runMigrations(url);
  return async () => { await stop(); };
}
```

`tests/helpers/db.ts`:
```ts
import { createPool, type Pool } from "../../src/db/pool.js";

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set; the global setup did not run");
  return url;
}

let shared: Pool | undefined;
export function testPool(): Pool {
  shared ??= createPool(testDatabaseUrl());
  return shared;
}
```

If `embedded-postgres` fails to start on this Windows machine, do not fight it for more than twenty minutes. Create a free Neon project named `plutus-test`, put its direct URL in `TEST_DATABASE_URL` in `.env.test`, and load that file in `vitest.config.ts` with `process.loadEnvFile(".env.test")` guarded by `existsSync`. Record which path was taken in the task report.

- [ ] **Step 4: Failing tests for the schema and the SQL canonical function**

`tests/integration/migrations.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { testPool } from "../helpers/db.js";

describe("schema", () => {
  it("has every table the spec names", async () => {
    const { rows } = await testPool().query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ["assets", "api_keys", "ledgers", "accounts", "transfers", "transfer_legs", "holds", "journal", "events", "schema_migrations"]) {
      expect(names).toContain(t);
    }
  });
  it("seeds six assets with the right exponents", async () => {
    const { rows } = await testPool().query<{ code: string; exponent: number }>("select code, exponent from assets order by code");
    expect(rows).toEqual([
      { code: "BTC", exponent: 8 }, { code: "ETH", exponent: 8 }, { code: "GHS", exponent: 2 },
      { code: "HKD", exponent: 2 }, { code: "USD", exponent: 2 }, { code: "USDT", exponent: 6 },
    ]);
  });
  it("returns bigint columns as strings", async () => {
    const { rows } = await testPool().query<{ n: string }>("select 9223372036854775807::bigint as n");
    expect(rows[0]?.n).toBe("9223372036854775807");
    expect(typeof rows[0]?.n).toBe("string");
  });
  it("is idempotent", async () => {
    const { runMigrations } = await import("../../src/db/migrate.js");
    const { testDatabaseUrl } = await import("../helpers/db.js");
    expect(await runMigrations(testDatabaseUrl())).toEqual([]);
  });
});
```

`tests/integration/canonical-sql.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { testPool } from "../helpers/db.js";
import { canonicalJson, hashEntry, GENESIS_HASH } from "../../src/domain/canonical.js";

const VECTORS: Array<Record<string, unknown>> = [
  { b: 1, a: { d: "x", c: [true, null] } },
  { s: 'q"\\\n\t\u0001' },
  { s: "cedi \u20B5", z: [], o: {} },
  { seq: 12, amount: "100000000", at: "2026-09-04T10:00:00.000Z", legs: [{ from: "a", to: "b", from_hold: null }] },
];

describe("canonical_json in SQL matches canonicalJson in TypeScript", () => {
  for (const v of VECTORS) {
    it(JSON.stringify(v).slice(0, 40), async () => {
      const { rows } = await testPool().query<{ c: string }>("select canonical_json($1::jsonb) as c", [JSON.stringify(v)]);
      expect(rows[0]?.c).toBe(canonicalJson(v as never));
    });
  }
  it("hashes the same bytes", async () => {
    const canonical = '{"a":1}';
    const { rows } = await testPool().query<{ h: string }>(
      "select encode(sha256(decode(repeat('00', 32), 'hex') || convert_to($1, 'UTF8')), 'hex') as h", [canonical],
    );
    expect(rows[0]?.h).toBe(hashEntry(GENESIS_HASH, canonical).toString("hex"));
  });
  it("refuses fractional numbers", async () => {
    await expect(testPool().query("select canonical_json('{\"x\":1.5}'::jsonb)")).rejects.toThrow(/integer/);
  });
});
```

- [ ] **Step 5: Run, fix, run again**

Run: `npx vitest run tests/integration`
Expected on the first run: the global setup starts Postgres and applies four migrations; both files pass. If the canonical vector with `\u0001` disagrees, the difference is escaping: Postgres `to_json` emits `\u0001` in lowercase hex like JavaScript does, so investigate before changing either side. Never make the test pass by weakening a vector.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "The schema, the migrations runner, and a real Postgres for every test run"
```

---

### Task 4: The money functions in Postgres, and their TypeScript wrappers

**Files:**
- Create: `db/migrations/0005_ledger_functions.sql`
- Create: `src/db/errors.ts`, `src/db/ledger.ts`
- Test: `tests/integration/ledger-functions.test.ts`, `tests/integration/concurrency.test.ts`

**Interfaces:**
- Produces in SQL: `resolve_account(ledger, ref, asset, now) returns text`, `append_journal(ledger, kind, entity, payload, now) returns jsonb {seq, hash, event_id}`, `post_transfer(ledger, transfer_id, legs jsonb, memo, metadata, now) returns jsonb {id, seq, legs, event_ids}`, `create_hold(ledger, hold_id, account, amount, expires_at, memo, metadata, now) returns jsonb {id, seq, event_ids}`, `release_hold(ledger, hold_id, kind, now) returns jsonb {id, released, seq, event_ids}`, `expire_holds(ledger, account_or_null, now) returns int`.
- Produces in TypeScript (`src/db/ledger.ts`), every function taking a `PoolClient` so callers control the transaction:
  - `createLedger(c, { id, keyId, name })`, `getLedger(c, keyId, ledgerId)`, `listLedgers(c, keyId, page)`, `countLedgers(c, keyId)`
  - `createAccount(c, { id, ledgerId, asset, name, metadata })`, `getAccount(c, ledgerId, accountId)`, `listAccounts(c, ledgerId, page)`, `countAccounts(c, ledgerId)`
  - `postTransfer(c, { ledgerId, transferId, legs, memo, metadata })`, `getTransfer(c, ledgerId, transferId)`, `listTransfers(c, ledgerId, page, accountId?)`
  - `createHold(c, { ledgerId, holdId, accountId, amount, expiresAt, memo, metadata })`, `releaseHold(c, ledgerId, holdId, kind)`, `expireHolds(c, ledgerId, accountId | null)`, `getHold(c, ledgerId, holdId)`, `listHolds(c, ledgerId, page, filters)`, `countOpenHolds(c, accountId)`
  - `listJournal(c, ledgerId, sinceSeq, limit)`
  - Types: `LegInput = { from?: string; from_hold?: string; to: string; asset: string; amount: string }`, `Page = { limit: number; cursor: Cursor | null }`, `Paged<T> = { data: T[]; next_cursor: string | null }`, row types `LedgerRow`, `AccountRow`, `TransferRow`, `HoldRow`, `JournalRow`.
- Produces: `mapDbError(err: unknown): ApiError | null` in `src/db/errors.ts`.

- [ ] **Step 1: The functions**

`db/migrations/0005_ledger_functions.sql`:
```sql
create or replace function ledger_is_sandbox(p_ledger_id text) returns boolean
language sql stable as $$
  select k.mode = 'test' from ledgers l join api_keys k on k.id = l.key_id where l.id = p_ledger_id
$$;

create or replace function resolve_account(p_ledger_id text, p_ref text, p_asset text, p_now timestamptz)
returns text language plpgsql as $$
declare
  v_id text;
  v_world_asset text;
begin
  if p_ref like 'world:%' then
    v_world_asset := substr(p_ref, 7);
    if v_world_asset <> p_asset then
      raise exception 'asset_mismatch' using detail = p_ref;
    end if;
    select id into v_id from accounts where ledger_id = p_ledger_id and kind = 'world' and asset = p_asset;
    if v_id is null then
      v_id := new_id('acct');
      insert into accounts (id, ledger_id, asset, name, kind, created_at)
        values (v_id, p_ledger_id, p_asset, 'world', 'world', p_now);
    end if;
    return v_id;
  end if;
  select id into v_id from accounts where id = p_ref and ledger_id = p_ledger_id;
  if v_id is null then
    raise exception 'account_not_found' using detail = p_ref;
  end if;
  return v_id;
end $$;

-- The caller holds the ledger row lock. Appends one entry, extends the chain,
-- writes the matching event row, and returns the sequence, hash and event id.
create or replace function append_journal(p_ledger_id text, p_kind text, p_entity_id text, p_payload jsonb, p_now timestamptz)
returns jsonb language plpgsql as $$
declare
  v_seq bigint;
  v_prev bytea;
  v_key text;
  v_payload jsonb;
  v_hash bytea;
  v_event_id text;
begin
  select next_seq, head_hash, key_id into v_seq, v_prev, v_key from ledgers where id = p_ledger_id for update;
  if v_seq is null then
    raise exception 'ledger_not_found';
  end if;
  if v_seq > 10000 and ledger_is_sandbox(p_ledger_id) then
    raise exception 'sandbox_limit_reached' using detail = 'journal_entries_per_ledger';
  end if;
  v_payload := p_payload || jsonb_build_object('seq', v_seq, 'kind', p_kind, 'ledger', p_ledger_id, 'at', fmt_ts(p_now));
  v_hash := sha256(v_prev || convert_to(canonical_json(v_payload), 'UTF8'));
  insert into journal (ledger_id, seq, kind, entity_id, payload, prev_hash, hash, created_at)
    values (p_ledger_id, v_seq, p_kind, p_entity_id, v_payload, v_prev, v_hash, p_now);
  v_event_id := new_id('evt');
  insert into events (id, key_id, ledger_id, type, entity_id, payload, created_at)
    values (v_event_id, v_key, p_ledger_id, p_kind, p_entity_id, v_payload, p_now);
  update ledgers set next_seq = v_seq + 1, head_hash = v_hash, last_activity_at = p_now where id = p_ledger_id;
  return jsonb_build_object('seq', v_seq, 'hash', encode(v_hash, 'hex'), 'event_id', v_event_id);
end $$;

create or replace function post_transfer(p_ledger_id text, p_transfer_id text, p_legs jsonb, p_memo text, p_metadata jsonb, p_now timestamptz)
returns jsonb language plpgsql as $$
declare
  v_n int;
  v_i int;
  v_leg jsonb;
  v_asset text;
  v_amount bigint;
  v_from text;
  v_to text;
  v_hold text;
  v_ids text[] := '{}';
  v_resolved jsonb := '[]'::jsonb;
  v_from_row accounts%rowtype;
  v_to_row accounts%rowtype;
  v_hold_row holds%rowtype;
  v_entry jsonb;
  v_hold_entry jsonb;
  v_events jsonb := '[]'::jsonb;
  v_closed text[] := '{}';
begin
  perform 1 from ledgers where id = p_ledger_id for update;
  if not found then
    raise exception 'ledger_not_found';
  end if;
  v_n := jsonb_array_length(p_legs);
  if v_n < 1 or v_n > 20 then
    raise exception 'validation_failed' using detail = 'legs must have between 1 and 20 entries';
  end if;

  -- Pass one: resolve every account and collect ids. World accounts are created here,
  -- safely, because the ledger lock above serialises writers.
  for v_i in 0 .. v_n - 1 loop
    v_leg := p_legs -> v_i;
    v_asset := v_leg ->> 'asset';
    v_amount := (v_leg ->> 'amount')::bigint;
    if v_amount is null or v_amount <= 0 then
      raise exception 'validation_failed' using detail = format('leg %s amount must be positive', v_i);
    end if;
    v_hold := v_leg ->> 'from_hold';
    if v_hold is not null then
      select * into v_hold_row from holds where id = v_hold and ledger_id = p_ledger_id;
      if not found then
        raise exception 'hold_not_found' using detail = format('leg %s', v_i);
      end if;
      v_from := v_hold_row.account_id;
    else
      v_from := resolve_account(p_ledger_id, v_leg ->> 'from', v_asset, p_now);
    end if;
    v_to := resolve_account(p_ledger_id, v_leg ->> 'to', v_asset, p_now);
    if v_from = v_to then
      raise exception 'validation_failed' using detail = format('leg %s moves money from an account to itself', v_i);
    end if;
    v_ids := v_ids || v_from || v_to;
    v_resolved := v_resolved || jsonb_build_object(
      'from', v_from, 'to', v_to, 'asset', v_asset, 'amount', v_amount::text, 'from_hold', v_hold);
  end loop;

  -- Lock every touched account in one fixed order. Two transfers touching the same
  -- accounts queue here instead of deadlocking.
  perform 1 from accounts where id = any(v_ids) order by id for update;

  -- Pass two: check and apply, reading each account fresh so a second leg on the
  -- same account sees the first leg's effect.
  for v_i in 0 .. v_n - 1 loop
    v_leg := v_resolved -> v_i;
    v_from := v_leg ->> 'from';
    v_to := v_leg ->> 'to';
    v_asset := v_leg ->> 'asset';
    v_amount := (v_leg ->> 'amount')::bigint;
    v_hold := v_leg ->> 'from_hold';
    select * into v_from_row from accounts where id = v_from;
    select * into v_to_row from accounts where id = v_to;
    if v_from_row.asset <> v_asset or v_to_row.asset <> v_asset then
      raise exception 'asset_mismatch' using detail = format('leg %s', v_i);
    end if;
    if v_hold is not null then
      select * into v_hold_row from holds where id = v_hold for update;
      if v_hold_row.status <> 'open' then
        raise exception 'hold_not_open' using detail = format('leg %s', v_i);
      end if;
      if v_hold_row.account_id <> v_from or v_hold_row.asset <> v_asset then
        raise exception 'asset_mismatch' using detail = format('leg %s hold', v_i);
      end if;
      if v_hold_row.remaining < v_amount then
        raise exception 'insufficient_funds' using detail = format('leg %s hold remaining %s', v_i, v_hold_row.remaining);
      end if;
      update holds set remaining = remaining - v_amount where id = v_hold;
      update accounts set balance = balance - v_amount, held = held - v_amount where id = v_from;
      if v_hold_row.remaining = v_amount then
        update holds set status = 'captured', closed_at = p_now where id = v_hold;
        v_closed := v_closed || v_hold;
      end if;
    else
      if v_from_row.kind = 'normal' and v_from_row.balance - v_from_row.held < v_amount then
        raise exception 'insufficient_funds' using detail = format('leg %s available %s', v_i, v_from_row.balance - v_from_row.held);
      end if;
      update accounts set balance = balance - v_amount where id = v_from;
    end if;
    update accounts set balance = balance + v_amount where id = v_to;
  end loop;

  insert into transfers (id, ledger_id, memo, metadata, created_at)
    values (p_transfer_id, p_ledger_id, coalesce(p_memo, ''), coalesce(p_metadata, '{}'::jsonb), p_now);
  for v_i in 0 .. v_n - 1 loop
    v_leg := v_resolved -> v_i;
    insert into transfer_legs (transfer_id, position, from_account, from_hold, to_account, asset, amount)
      values (p_transfer_id, v_i, v_leg ->> 'from', v_leg ->> 'from_hold', v_leg ->> 'to', v_leg ->> 'asset', (v_leg ->> 'amount')::bigint);
  end loop;

  v_entry := append_journal(p_ledger_id, 'transfer.posted', p_transfer_id,
    jsonb_build_object('transfer', jsonb_build_object(
      'id', p_transfer_id, 'memo', coalesce(p_memo, ''), 'metadata', coalesce(p_metadata, '{}'::jsonb), 'legs', v_resolved)),
    p_now);
  update transfers set seq = (v_entry ->> 'seq')::bigint where id = p_transfer_id;
  v_events := v_events || to_jsonb(v_entry ->> 'event_id');

  foreach v_hold in array v_closed loop
    select * into v_hold_row from holds where id = v_hold;
    v_hold_entry := append_journal(p_ledger_id, 'hold.captured', v_hold,
      jsonb_build_object('hold', jsonb_build_object(
        'id', v_hold, 'account', v_hold_row.account_id, 'asset', v_hold_row.asset, 'amount', v_hold_row.amount::text)),
      p_now);
    v_events := v_events || to_jsonb(v_hold_entry ->> 'event_id');
  end loop;

  return jsonb_build_object('id', p_transfer_id, 'seq', (v_entry ->> 'seq')::bigint, 'legs', v_resolved, 'event_ids', v_events);
end $$;

create or replace function create_hold(p_ledger_id text, p_hold_id text, p_account text, p_amount bigint, p_expires_at timestamptz, p_memo text, p_metadata jsonb, p_now timestamptz)
returns jsonb language plpgsql as $$
declare
  v_acc accounts%rowtype;
  v_entry jsonb;
  v_open int;
begin
  perform 1 from ledgers where id = p_ledger_id for update;
  if not found then
    raise exception 'ledger_not_found';
  end if;
  select * into v_acc from accounts where id = p_account and ledger_id = p_ledger_id for update;
  if not found then
    raise exception 'account_not_found' using detail = p_account;
  end if;
  if v_acc.kind <> 'normal' then
    raise exception 'validation_failed' using detail = 'holds are not allowed on world accounts';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'validation_failed' using detail = 'amount must be positive';
  end if;
  if ledger_is_sandbox(p_ledger_id) then
    select count(*) into v_open from holds where account_id = p_account and status = 'open';
    if v_open >= 100 then
      raise exception 'sandbox_limit_reached' using detail = 'open_holds_per_account';
    end if;
  end if;
  if v_acc.balance - v_acc.held < p_amount then
    raise exception 'insufficient_funds' using detail = format('available %s', v_acc.balance - v_acc.held);
  end if;
  update accounts set held = held + p_amount where id = p_account;
  insert into holds (id, ledger_id, account_id, asset, amount, remaining, status, expires_at, memo, metadata, created_at)
    values (p_hold_id, p_ledger_id, p_account, v_acc.asset, p_amount, p_amount, 'open', p_expires_at, coalesce(p_memo, ''), coalesce(p_metadata, '{}'::jsonb), p_now);
  v_entry := append_journal(p_ledger_id, 'hold.created', p_hold_id,
    jsonb_build_object('hold', jsonb_build_object(
      'id', p_hold_id, 'account', p_account, 'asset', v_acc.asset, 'amount', p_amount::text,
      'expires_at', fmt_ts(p_expires_at), 'memo', coalesce(p_memo, ''), 'metadata', coalesce(p_metadata, '{}'::jsonb))),
    p_now);
  return jsonb_build_object('id', p_hold_id, 'seq', (v_entry ->> 'seq')::bigint, 'event_ids', jsonb_build_array(v_entry ->> 'event_id'));
end $$;

-- p_kind is 'hold.released' or 'hold.expired'. Returns the remaining amount to available.
create or replace function release_hold(p_ledger_id text, p_hold_id text, p_kind text, p_now timestamptz)
returns jsonb language plpgsql as $$
declare
  v_hold holds%rowtype;
  v_entry jsonb;
begin
  if p_kind not in ('hold.released', 'hold.expired') then
    raise exception 'validation_failed' using detail = 'kind';
  end if;
  perform 1 from ledgers where id = p_ledger_id for update;
  if not found then
    raise exception 'ledger_not_found';
  end if;
  select * into v_hold from holds where id = p_hold_id and ledger_id = p_ledger_id for update;
  if not found then
    raise exception 'hold_not_found' using detail = p_hold_id;
  end if;
  if v_hold.status <> 'open' then
    raise exception 'hold_not_open' using detail = v_hold.status;
  end if;
  perform 1 from accounts where id = v_hold.account_id for update;
  update accounts set held = held - v_hold.remaining where id = v_hold.account_id;
  update holds set status = case when p_kind = 'hold.expired' then 'expired' else 'released' end,
    remaining = 0, closed_at = p_now where id = p_hold_id;
  v_entry := append_journal(p_ledger_id, p_kind, p_hold_id,
    jsonb_build_object('hold', jsonb_build_object(
      'id', p_hold_id, 'account', v_hold.account_id, 'asset', v_hold.asset, 'amount', v_hold.remaining::text)),
    p_now);
  return jsonb_build_object('id', p_hold_id, 'released', v_hold.remaining::text, 'seq', (v_entry ->> 'seq')::bigint,
    'event_ids', jsonb_build_array(v_entry ->> 'event_id'));
end $$;

create or replace function expire_holds(p_ledger_id text, p_account text, p_now timestamptz)
returns int language plpgsql as $$
declare
  v_id text;
  v_count int := 0;
begin
  for v_id in
    select id from holds
    where ledger_id = p_ledger_id and status = 'open' and expires_at <= p_now
      and (p_account is null or account_id = p_account)
    order by created_at, id
  loop
    perform release_hold(p_ledger_id, v_id, 'hold.expired', p_now);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
```

- [ ] **Step 2: Error mapping and the wrappers**

`src/db/errors.ts`:
```ts
import { ApiError, type ErrorCode } from "../domain/errors.js";

interface PgLikeError { message?: string; detail?: string; code?: string }

const RAISED: Record<string, { status: number; code: ErrorCode }> = {
  insufficient_funds: { status: 409, code: "insufficient_funds" },
  asset_mismatch: { status: 422, code: "asset_mismatch" },
  hold_not_open: { status: 409, code: "hold_not_open" },
  hold_not_found: { status: 404, code: "not_found" },
  account_not_found: { status: 404, code: "not_found" },
  ledger_not_found: { status: 404, code: "not_found" },
  validation_failed: { status: 422, code: "validation_failed" },
  sandbox_limit_reached: { status: 409, code: "sandbox_limit_reached" },
};

/** Turns an exception raised by our SQL functions into an ApiError. Anything else returns null. */
export function mapDbError(err: unknown): ApiError | null {
  const e = err as PgLikeError;
  if (typeof e?.message !== "string") return null;
  const hit = RAISED[e.message];
  if (!hit) return null;
  const detail = e.detail ? `${e.message.replaceAll("_", " ")}: ${e.detail}` : e.message.replaceAll("_", " ");
  return new ApiError(hit.status, hit.code, detail);
}
```

`src/db/ledger.ts` (the long one; every function is small):
```ts
import type { PoolClient } from "pg";
import { encodeCursor, type Cursor } from "../domain/cursor.js";

export interface Page { limit: number; cursor: Cursor | null }
export interface Paged<T> { data: T[]; next_cursor: string | null }

export interface LedgerRow { id: string; key_id: string; name: string; next_seq: string; head_hash: Buffer; last_activity_at: Date; created_at: Date }
export interface AccountRow { id: string; ledger_id: string; asset: string; name: string; kind: "normal" | "world"; balance: string; held: string; metadata: Record<string, string>; created_at: Date }
export interface TransferRow { id: string; ledger_id: string; seq: string; memo: string; metadata: Record<string, string>; created_at: Date; legs: LegRow[] }
export interface LegRow { position: number; from_account: string; from_hold: string | null; to_account: string; asset: string; amount: string }
export interface HoldRow { id: string; ledger_id: string; account_id: string; asset: string; amount: string; remaining: string; status: "open" | "captured" | "released" | "expired"; expires_at: Date; memo: string; metadata: Record<string, string>; created_at: Date; closed_at: Date | null }
export interface JournalRow { ledger_id: string; seq: string; kind: string; entity_id: string; payload: Record<string, unknown>; prev_hash: Buffer; hash: Buffer; created_at: Date }
export interface LegInput { from?: string; from_hold?: string; to: string; asset: string; amount: string }
export interface WriteResult { id: string; seq: string; event_ids: string[] }

/** Newest first pagination over (created_at, id). Fetches one extra row to learn if there is a next page. */
function pageOf<T extends { created_at: Date; id: string }>(rows: T[], limit: number): Paged<T> {
  const data = rows.slice(0, limit);
  const last = rows.length > limit ? data[data.length - 1] : undefined;
  return { data, next_cursor: last ? encodeCursor({ t: last.created_at.toISOString(), id: last.id }) : null };
}

export async function createLedger(c: PoolClient, input: { id: string; keyId: string; name: string }): Promise<LedgerRow> {
  const { rows } = await c.query<LedgerRow>(
    "insert into ledgers (id, key_id, name) values ($1, $2, $3) returning *", [input.id, input.keyId, input.name]);
  return rows[0] as LedgerRow;
}

export async function getLedger(c: PoolClient, keyId: string, ledgerId: string): Promise<LedgerRow | null> {
  const { rows } = await c.query<LedgerRow>("select * from ledgers where id = $1 and key_id = $2", [ledgerId, keyId]);
  return rows[0] ?? null;
}

export async function countLedgers(c: PoolClient, keyId: string): Promise<number> {
  const { rows } = await c.query<{ n: string }>("select count(*)::text as n from ledgers where key_id = $1", [keyId]);
  return Number(rows[0]?.n ?? "0");
}

export async function listLedgers(c: PoolClient, keyId: string, page: Page): Promise<Paged<LedgerRow>> {
  const { rows } = await c.query<LedgerRow>(
    `select * from ledgers where key_id = $1
       and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::text))
     order by created_at desc, id desc limit $4`,
    [keyId, page.cursor?.t ?? null, page.cursor?.id ?? "", page.limit + 1]);
  return pageOf(rows, page.limit);
}

export async function createAccount(c: PoolClient, input: { id: string; ledgerId: string; asset: string; name: string; metadata: Record<string, string> }): Promise<AccountRow> {
  const { rows } = await c.query<AccountRow>(
    "insert into accounts (id, ledger_id, asset, name, kind, metadata) values ($1, $2, $3, $4, 'normal', $5) returning *",
    [input.id, input.ledgerId, input.asset, input.name, JSON.stringify(input.metadata)]);
  return rows[0] as AccountRow;
}

export async function getAccount(c: PoolClient, ledgerId: string, accountId: string): Promise<AccountRow | null> {
  const { rows } = await c.query<AccountRow>("select * from accounts where id = $1 and ledger_id = $2", [accountId, ledgerId]);
  return rows[0] ?? null;
}

export async function countAccounts(c: PoolClient, ledgerId: string): Promise<number> {
  const { rows } = await c.query<{ n: string }>("select count(*)::text as n from accounts where ledger_id = $1 and kind = 'normal'", [ledgerId]);
  return Number(rows[0]?.n ?? "0");
}

export async function listAccounts(c: PoolClient, ledgerId: string, page: Page): Promise<Paged<AccountRow>> {
  const { rows } = await c.query<AccountRow>(
    `select * from accounts where ledger_id = $1
       and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::text))
     order by created_at desc, id desc limit $4`,
    [ledgerId, page.cursor?.t ?? null, page.cursor?.id ?? "", page.limit + 1]);
  return pageOf(rows, page.limit);
}

export async function postTransfer(c: PoolClient, input: { ledgerId: string; transferId: string; legs: LegInput[]; memo: string; metadata: Record<string, string> }): Promise<WriteResult> {
  const { rows } = await c.query<{ r: { id: string; seq: number; event_ids: string[] } }>(
    "select post_transfer($1, $2, $3::jsonb, $4, $5::jsonb, now()) as r",
    [input.ledgerId, input.transferId, JSON.stringify(input.legs), input.memo, JSON.stringify(input.metadata)]);
  const r = (rows[0] as { r: { id: string; seq: number; event_ids: string[] } }).r;
  return { id: r.id, seq: String(r.seq), event_ids: r.event_ids };
}

export async function getTransfer(c: PoolClient, ledgerId: string, transferId: string): Promise<TransferRow | null> {
  const { rows } = await c.query<TransferRow>(
    `select t.*, coalesce((select json_agg(json_build_object(
        'position', l.position, 'from_account', l.from_account, 'from_hold', l.from_hold,
        'to_account', l.to_account, 'asset', l.asset, 'amount', l.amount::text) order by l.position)
       from transfer_legs l where l.transfer_id = t.id), '[]'::json) as legs
     from transfers t where t.id = $1 and t.ledger_id = $2`, [transferId, ledgerId]);
  return rows[0] ?? null;
}

export async function listTransfers(c: PoolClient, ledgerId: string, page: Page, accountId: string | null): Promise<Paged<TransferRow>> {
  const { rows } = await c.query<TransferRow>(
    `select t.*, coalesce((select json_agg(json_build_object(
        'position', l.position, 'from_account', l.from_account, 'from_hold', l.from_hold,
        'to_account', l.to_account, 'asset', l.asset, 'amount', l.amount::text) order by l.position)
       from transfer_legs l where l.transfer_id = t.id), '[]'::json) as legs
     from transfers t
     where t.ledger_id = $1
       and ($2::timestamptz is null or (t.created_at, t.id) < ($2::timestamptz, $3::text))
       and ($5::text is null or exists (select 1 from transfer_legs l where l.transfer_id = t.id and (l.from_account = $5 or l.to_account = $5)))
     order by t.created_at desc, t.id desc limit $4`,
    [ledgerId, page.cursor?.t ?? null, page.cursor?.id ?? "", page.limit + 1, accountId]);
  return pageOf(rows, page.limit);
}

export async function createHold(c: PoolClient, input: { ledgerId: string; holdId: string; accountId: string; amount: string; expiresAt: Date; memo: string; metadata: Record<string, string> }): Promise<WriteResult> {
  const { rows } = await c.query<{ r: { id: string; seq: number; event_ids: string[] } }>(
    "select create_hold($1, $2, $3, $4::bigint, $5, $6, $7::jsonb, now()) as r",
    [input.ledgerId, input.holdId, input.accountId, input.amount, input.expiresAt, input.memo, JSON.stringify(input.metadata)]);
  const r = (rows[0] as { r: { id: string; seq: number; event_ids: string[] } }).r;
  return { id: r.id, seq: String(r.seq), event_ids: r.event_ids };
}

export async function releaseHold(c: PoolClient, ledgerId: string, holdId: string, kind: "hold.released" | "hold.expired"): Promise<WriteResult & { released: string }> {
  const { rows } = await c.query<{ r: { id: string; released: string; seq: number; event_ids: string[] } }>(
    "select release_hold($1, $2, $3, now()) as r", [ledgerId, holdId, kind]);
  const r = (rows[0] as { r: { id: string; released: string; seq: number; event_ids: string[] } }).r;
  return { id: r.id, seq: String(r.seq), event_ids: r.event_ids, released: r.released };
}

export async function expireHolds(c: PoolClient, ledgerId: string, accountId: string | null): Promise<number> {
  const { rows } = await c.query<{ n: number }>("select expire_holds($1, $2, now()) as n", [ledgerId, accountId]);
  return rows[0]?.n ?? 0;
}

export async function getHold(c: PoolClient, ledgerId: string, holdId: string): Promise<HoldRow | null> {
  const { rows } = await c.query<HoldRow>("select * from holds where id = $1 and ledger_id = $2", [holdId, ledgerId]);
  return rows[0] ?? null;
}

export async function listHolds(c: PoolClient, ledgerId: string, page: Page, filters: { accountId: string | null; status: string | null }): Promise<Paged<HoldRow>> {
  const { rows } = await c.query<HoldRow>(
    `select * from holds where ledger_id = $1
       and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::text))
       and ($5::text is null or account_id = $5) and ($6::text is null or status = $6)
     order by created_at desc, id desc limit $4`,
    [ledgerId, page.cursor?.t ?? null, page.cursor?.id ?? "", page.limit + 1, filters.accountId, filters.status]);
  return pageOf(rows, page.limit);
}

export async function countOpenHolds(c: PoolClient, accountId: string): Promise<number> {
  const { rows } = await c.query<{ n: string }>("select count(*)::text as n from holds where account_id = $1 and status = 'open'", [accountId]);
  return Number(rows[0]?.n ?? "0");
}

export async function listJournal(c: PoolClient, ledgerId: string, sinceSeq: bigint, limit: number): Promise<JournalRow[]> {
  const { rows } = await c.query<JournalRow>(
    "select * from journal where ledger_id = $1 and seq > $2::bigint order by seq asc limit $3",
    [ledgerId, sinceSeq.toString(), limit]);
  return rows;
}
```

`Number(...)` on counts is fine: counts are not money. The house rules ban `parseFloat` and `toFixed`, not `Number`, and counts never exceed the ceilings.

- [ ] **Step 3: Failing integration tests**

`tests/integration/ledger-functions.test.ts` (uses a helper to make a key and ledger directly in SQL, since the HTTP layer does not exist yet):
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { testPool } from "../helpers/db.js";
import { withTx } from "../../src/db/pool.js";
import { newId } from "../../src/domain/ids.js";
import { canonicalJson, hashEntry, GENESIS_HASH, type JsonValue } from "../../src/domain/canonical.js";
import { mapDbError } from "../../src/db/errors.js";
import * as L from "../../src/db/ledger.js";

async function seedKey(mode: "test" | "live" = "test"): Promise<string> {
  const id = newId("key");
  const hash = createHash("sha256").update(randomBytes(32)).digest();
  await testPool().query(
    "insert into api_keys (id, secret_hash, prefix, last4, mode, scopes) values ($1, $2, 'pl_test', 'abcd', $3, '{ledger:read,ledger:write}')",
    [id, hash, mode]);
  return id;
}

async function seedLedger(): Promise<{ keyId: string; ledgerId: string; a: string; b: string }> {
  const keyId = await seedKey();
  return withTx(testPool(), async (c) => {
    const ledger = await L.createLedger(c, { id: newId("ldg"), keyId, name: "t" });
    const a = await L.createAccount(c, { id: newId("acct"), ledgerId: ledger.id, asset: "GHS", name: "a", metadata: {} });
    const b = await L.createAccount(c, { id: newId("acct"), ledgerId: ledger.id, asset: "GHS", name: "b", metadata: {} });
    return { keyId, ledgerId: ledger.id, a: a.id, b: b.id };
  });
}

async function balances(ledgerId: string): Promise<Array<{ id: string; kind: string; balance: string; held: string }>> {
  const { rows } = await testPool().query("select id, kind, balance::text, held::text from accounts where ledger_id = $1 order by id", [ledgerId]);
  return rows;
}

describe("post_transfer", () => {
  let s: Awaited<ReturnType<typeof seedLedger>>;
  beforeAll(async () => { s = await seedLedger(); });

  it("funds an account from the world and the ledger sums to zero", async () => {
    const r = await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: "world:GHS", to: s.a, asset: "GHS", amount: "1000" }], memo: "fund", metadata: {} }));
    expect(r.seq).toBe("1");
    expect(r.event_ids).toHaveLength(1);
    const rows = await balances(s.ledgerId);
    const sum = rows.reduce((acc, r) => acc + BigInt(r.balance), 0n);
    expect(sum).toBe(0n);
    expect(rows.find((r) => r.kind === "world")?.balance).toBe("-1000");
  });

  it("moves money between accounts and refuses an overdraft", async () => {
    await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: s.a, to: s.b, asset: "GHS", amount: "400" }], memo: "", metadata: {} }));
    const err = await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: s.a, to: s.b, asset: "GHS", amount: "601" }], memo: "", metadata: {} })).catch((e: unknown) => e);
    const mapped = mapDbError(err);
    expect(mapped?.code).toBe("insufficient_funds");
    expect(mapped?.status).toBe(409);
    expect(mapped?.message).toContain("available 600");
  });

  it("applies several legs atomically or not at all", async () => {
    const before = await balances(s.ledgerId);
    const err = await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [
      { from: s.a, to: s.b, asset: "GHS", amount: "100" },
      { from: s.b, to: s.a, asset: "GHS", amount: "999999" },
    ], memo: "", metadata: {} })).catch((e: unknown) => e);
    expect(mapDbError(err)?.code).toBe("insufficient_funds");
    expect(await balances(s.ledgerId)).toEqual(before);
  });

  it("refuses a leg whose account holds a different asset", async () => {
    const usd = await withTx(testPool(), (c) => L.createAccount(c, { id: newId("acct"), ledgerId: s.ledgerId, asset: "USD", name: "usd", metadata: {} }));
    const err = await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: s.a, to: usd.id, asset: "GHS", amount: "1" }], memo: "", metadata: {} })).catch((e: unknown) => e);
    expect(mapDbError(err)?.code).toBe("asset_mismatch");
  });

  it("refuses more than twenty legs, a self transfer, and a foreign account", async () => {
    const many = Array.from({ length: 21 }, () => ({ from: s.a, to: s.b, asset: "GHS", amount: "1" }));
    expect(mapDbError(await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: many, memo: "", metadata: {} })).catch((e: unknown) => e))?.code).toBe("validation_failed");
    expect(mapDbError(await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: s.a, to: s.a, asset: "GHS", amount: "1" }], memo: "", metadata: {} })).catch((e: unknown) => e))?.code).toBe("validation_failed");
    const other = await seedLedger();
    expect(mapDbError(await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: other.a, to: s.b, asset: "GHS", amount: "1" }], memo: "", metadata: {} })).catch((e: unknown) => e))?.code).toBe("not_found");
  });

  it("writes a journal whose hashes the TypeScript side can recompute", async () => {
    const rows = await withTx(testPool(), (c) => L.listJournal(c, s.ledgerId, 0n, 100));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    let prev = GENESIS_HASH;
    for (const [i, row] of rows.entries()) {
      expect(row.seq).toBe(String(i + 1));
      expect(row.prev_hash.equals(prev)).toBe(true);
      const recomputed = hashEntry(prev, canonicalJson(row.payload as JsonValue));
      expect(recomputed.equals(row.hash)).toBe(true);
      prev = row.hash;
    }
    const { rows: led } = await testPool().query<{ head_hash: Buffer }>("select head_hash from ledgers where id = $1", [s.ledgerId]);
    expect(led[0]?.head_hash.equals(prev)).toBe(true);
  });
});

describe("holds", () => {
  it("reserves, captures partly, keeps the rest held, then releases", async () => {
    const s = await seedLedger();
    await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: "world:GHS", to: s.a, asset: "GHS", amount: "1000" }], memo: "", metadata: {} }));
    const holdId = newId("hold");
    await withTx(testPool(), (c) => L.createHold(c, { ledgerId: s.ledgerId, holdId, accountId: s.a, amount: "600", expiresAt: new Date(Date.now() + 60_000), memo: "", metadata: {} }));
    let a = (await balances(s.ledgerId)).find((r) => r.id === s.a);
    expect(a?.held).toBe("600");
    // Only 400 is available now.
    expect(mapDbError(await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: s.a, to: s.b, asset: "GHS", amount: "401" }], memo: "", metadata: {} })).catch((e: unknown) => e))?.code).toBe("insufficient_funds");
    // Capture 250 from the hold.
    await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from_hold: holdId, to: s.b, asset: "GHS", amount: "250" }], memo: "", metadata: {} }));
    a = (await balances(s.ledgerId)).find((r) => r.id === s.a);
    expect(a?.balance).toBe("750");
    expect(a?.held).toBe("350");
    const hold = await withTx(testPool(), (c) => L.getHold(c, s.ledgerId, holdId));
    expect(hold?.status).toBe("open");
    expect(hold?.remaining).toBe("350");
    // Release the rest.
    const rel = await withTx(testPool(), (c) => L.releaseHold(c, s.ledgerId, holdId, "hold.released"));
    expect(rel.released).toBe("350");
    a = (await balances(s.ledgerId)).find((r) => r.id === s.a);
    expect(a?.held).toBe("0");
    expect(mapDbError(await withTx(testPool(), (c) => L.releaseHold(c, s.ledgerId, holdId, "hold.released")).catch((e: unknown) => e))?.code).toBe("hold_not_open");
  });

  it("closes as captured when fully drawn, and expires on request", async () => {
    const s = await seedLedger();
    await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from: "world:GHS", to: s.a, asset: "GHS", amount: "100" }], memo: "", metadata: {} }));
    const h1 = newId("hold");
    await withTx(testPool(), (c) => L.createHold(c, { ledgerId: s.ledgerId, holdId: h1, accountId: s.a, amount: "40", expiresAt: new Date(Date.now() + 60_000), memo: "", metadata: {} }));
    const r = await withTx(testPool(), (c) => L.postTransfer(c, { ledgerId: s.ledgerId, transferId: newId("tr"), legs: [{ from_hold: h1, to: s.b, asset: "GHS", amount: "40" }], memo: "", metadata: {} }));
    expect(r.event_ids).toHaveLength(2); // transfer.posted and hold.captured
    expect((await withTx(testPool(), (c) => L.getHold(c, s.ledgerId, h1)))?.status).toBe("captured");
    const h2 = newId("hold");
    await withTx(testPool(), (c) => L.createHold(c, { ledgerId: s.ledgerId, holdId: h2, accountId: s.a, amount: "10", expiresAt: new Date(Date.now() - 1000), memo: "", metadata: {} }));
    expect(await withTx(testPool(), (c) => L.expireHolds(c, s.ledgerId, null))).toBe(1);
    expect((await withTx(testPool(), (c) => L.getHold(c, s.ledgerId, h2)))?.status).toBe("expired");
    expect((await balances(s.ledgerId)).find((x) => x.id === s.a)?.held).toBe("0");
  });

  it("refuses holds on world accounts and beyond available", async () => {
    const s = await seedLedger();
    const { rows } = await testPool().query<{ id: string }>("select resolve_account($1, 'world:GHS', 'GHS', now()) as id", [s.ledgerId]);
    const world = rows[0]?.id as string;
    expect(mapDbError(await withTx(testPool(), (c) => L.createHold(c, { ledgerId: s.ledgerId, holdId: newId("hold"), accountId: world, amount: "1", expiresAt: new Date(), memo: "", metadata: {} })).catch((e: unknown) => e))?.code).toBe("validation_failed");
    expect(mapDbError(await withTx(testPool(), (c) => L.createHold(c, { ledgerId: s.ledgerId, holdId: newId("hold"), accountId: s.a, amount: "1", expiresAt: new Date(), memo: "", metadata: {} })).catch((e: unknown) => e))?.code).toBe("insufficient_funds");
  });
});
```

`tests/integration/concurrency.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { testPool } from "../helpers/db.js";
import { withTx } from "../../src/db/pool.js";
import { newId } from "../../src/domain/ids.js";
import * as L from "../../src/db/ledger.js";

describe("two people, one balance", () => {
  it("fifty parallel transfers with money for twenty: exactly twenty post, no gap, never negative", async () => {
    const keyId = newId("key");
    await testPool().query("insert into api_keys (id, secret_hash, prefix, last4, mode, scopes) values ($1, $2, 'pl_test', 'abcd', 'test', '{ledger:write}')",
      [keyId, createHash("sha256").update(randomBytes(32)).digest()]);
    const { ledgerId, a, b } = await withTx(testPool(), async (c) => {
      const l = await L.createLedger(c, { id: newId("ldg"), keyId, name: "race" });
      const a = await L.createAccount(c, { id: newId("acct"), ledgerId: l.id, asset: "USD", name: "a", metadata: {} });
      const b = await L.createAccount(c, { id: newId("acct"), ledgerId: l.id, asset: "USD", name: "b", metadata: {} });
      await L.postTransfer(c, { ledgerId: l.id, transferId: newId("tr"), legs: [{ from: "world:USD", to: a.id, asset: "USD", amount: "2000" }], memo: "", metadata: {} });
      return { ledgerId: l.id, a: a.id, b: b.id };
    });
    // Each transfer is 100. 2000 covers exactly twenty. Fifty race for them on separate connections.
    const results = await Promise.allSettled(Array.from({ length: 50 }, () =>
      withTx(testPool(), (c) => L.postTransfer(c, { ledgerId, transferId: newId("tr"), legs: [{ from: a, to: b, asset: "USD", amount: "100" }], memo: "", metadata: {} }))));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(20);
    const { rows } = await testPool().query<{ balance: string; held: string }>("select balance::text, held::text from accounts where id = $1", [a]);
    expect(rows[0]?.balance).toBe("0");
    const journal = await withTx(testPool(), (c) => L.listJournal(c, ledgerId, 0n, 1000));
    expect(journal.map((j) => j.seq)).toEqual(journal.map((_, i) => String(i + 1)));
    expect(journal).toHaveLength(21);
  });
});
```

The pool has `max: 5`, so the fifty run five at a time on five real connections, which is enough to hit the lock. Do not raise `max` to make it "more parallel"; the lock is what is under test, and five connections prove it as well as fifty.

- [ ] **Step 4: Run, watch the first failures, fix, run green**

Run: `npx vitest run tests/integration`
Expected: the migration applies (the setup runs migrations on every start, and 0005 is new). All tests green. Typical first failures and what they mean: `function post_transfer(text, text, jsonb, text, jsonb, timestamp with time zone) does not exist` means the migration did not apply, check the file name sorts after 0004; `column "from_hold" ... violates foreign key` means legs are inserted before holds exist, which cannot happen in these tests, so read the SQL again.

- [ ] **Step 5: The mutation check, by hand, recorded in the report**

Temporarily change `perform 1 from accounts where id = any(v_ids) order by id for update;` in a scratch copy of 0005 to `perform 1 from accounts where id = any(v_ids);` and replace the check `v_from_row.balance - v_from_row.held < v_amount` with a read done before the ledger lock. Apply it to the test database with `psql` or a tiny tsx script, run `tests/integration/concurrency.test.ts`, and confirm it goes red with more than twenty successes or a negative balance. Restore the original function by re running the real migration file's function bodies. Write the observed red output into the task report. If the test does not go red under the mutation, the test is wrong, not the code.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Post transfers, hold and release money, and chain the journal, all inside Postgres"
```

---

### Task 5: The platform: request ids, logging, errors, the route registry, and app wiring

**Files:**
- Create: `src/deps.ts`, `src/platform/request-id.ts`, `src/platform/logger.ts`, `src/platform/error-handler.ts`, `src/platform/route.ts`, `src/platform/ratelimit.ts` (interface and memory implementation only; Upstash comes in Task 7), `src/platform/scheduler.ts` (interface and memory implementation; QStash comes in Task 11), `src/platform/cache.ts` (interface and memory implementation; Upstash comes in Task 10)
- Create: `src/routes/health.ts`, `src/schemas/common.ts`
- Modify: `src/app.ts`, `src/index.ts`
- Create: `tests/helpers/app.ts`
- Test: `tests/unit/route.test.ts`, `tests/integration/platform.test.ts`

**Interfaces:**
- Produces: `interface AppDeps { pool: Pool; limiter: RateLimiter; scheduler: DeliveryScheduler; cache: Cache; logger: Logger; config: Config }` and `buildProductionDeps(): AppDeps` in `src/deps.ts`.
- Produces: `createApp(deps: AppDeps): Express` in `src/app.ts`, and `app.locals.deps` set to the deps.
- Produces: `defineRoute(def: RouteDef): RouteDef` (identity with types), `mountRoutes(app, deps, routes: RouteDef[])`, `ROUTE_REGISTRY: RouteDef[]` for OpenAPI in `src/platform/route.ts`. `RouteDef` fields: `method`, `path` (OpenAPI style with `{id}`), `summary`, `tag`, `auth: "none" | "bearer"`, `scope?`, `limit?: "mint" | "verify" | "standard" | "none"`, `idempotent?: boolean`, `params?`, `query?`, `body?`, `response`, `status?`, `handler(ctx)`. `ctx` is `{ params, query, body, key: AuthedKey | null, requestId, ip, deps, req, res }`.
- Produces: `interface RateLimiter { limit(bucket: RateBucket, id: string): Promise<RateResult> }`, `type RateBucket = "mint" | "sandbox" | "live" | "verify"`, `type RateResult = { ok: boolean; limit: number; remaining: number; resetAt: number }`, `class MemoryRateLimiter`.
- Produces: `interface DeliveryScheduler { schedule(deliveryId: string, delaySeconds: number): Promise<void> }`, `class MemoryScheduler` that records `{ deliveryId, delaySeconds }` in `scheduled: Array<...>` and, when constructed with `{ runNow: (id) => Promise<void> }`, calls it for zero delay.
- Produces: `interface Cache { get(key: string): Promise<string | null>; set(key: string, value: string, ttlSeconds: number): Promise<void> }`, `class MemoryCache`.
- Produces: `makeTestApp(overrides?): Promise<{ app: Express; deps: AppDeps; scheduler: MemoryScheduler; limiter: MemoryRateLimiter }>` in `tests/helpers/app.ts`.
- Produces: `AmountString`, `Metadata`, `IdParam(prefix)`, `PageQuery`, `PagedOf(schema)`, `Problem` zod schemas in `src/schemas/common.ts`.
- `AuthedKey` type lives in `src/platform/auth.ts` (Task 6); this task declares it in `src/platform/route.ts` as `{ id: string; mode: "test" | "live"; scopes: string[]; prefix: string; last4: string }` and Task 6 re-exports it from there.

- [ ] **Step 1: Interfaces with memory implementations**

`src/platform/ratelimit.ts`:
```ts
export type RateBucket = "mint" | "sandbox" | "live" | "verify";
export interface RateResult { ok: boolean; limit: number; remaining: number; resetAt: number }
export interface RateLimiter { limit(bucket: RateBucket, id: string): Promise<RateResult> }

export const RATE_RULES: Record<RateBucket, { points: number; windowSeconds: number }> = {
  mint: { points: 5, windowSeconds: 3600 },
  sandbox: { points: 60, windowSeconds: 60 },
  live: { points: 600, windowSeconds: 60 },
  verify: { points: 10, windowSeconds: 60 },
};

/** Sliding window in process. Correct for one instance, which is exactly what tests and local dev are. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  async limit(bucket: RateBucket, id: string): Promise<RateResult> {
    const rule = RATE_RULES[bucket];
    const key = `${bucket}:${id}`;
    const t = this.now();
    const windowStart = t - rule.windowSeconds * 1000;
    const kept = (this.hits.get(key) ?? []).filter((h) => h > windowStart);
    const ok = kept.length < rule.points;
    if (ok) kept.push(t);
    this.hits.set(key, kept);
    const oldest = kept[0] ?? t;
    return { ok, limit: rule.points, remaining: Math.max(0, rule.points - kept.length), resetAt: oldest + rule.windowSeconds * 1000 };
  }
}
```

`src/platform/scheduler.ts`:
```ts
export interface DeliveryScheduler { schedule(deliveryId: string, delaySeconds: number): Promise<void> }

export class MemoryScheduler implements DeliveryScheduler {
  readonly scheduled: Array<{ deliveryId: string; delaySeconds: number }> = [];
  constructor(private readonly runNow?: (deliveryId: string) => Promise<void>) {}
  async schedule(deliveryId: string, delaySeconds: number): Promise<void> {
    this.scheduled.push({ deliveryId, delaySeconds });
    if (delaySeconds === 0 && this.runNow) await this.runNow(deliveryId);
  }
}
```

`src/platform/cache.ts`:
```ts
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export class MemoryCache implements Cache {
  private readonly items = new Map<string, { value: string; expiresAt: number }>();
  async get(key: string): Promise<string | null> {
    const hit = this.items.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) { this.items.delete(key); return null; }
    return hit.value;
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.items.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}
```

- [ ] **Step 2: Request id, logger, error handler**

`src/platform/request-id.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

const SAFE = /^[A-Za-z0-9._-]{8,128}$/;

export const requestId: RequestHandler = (req, res, next) => {
  const given = req.header("x-request-id");
  const id = given && SAFE.test(given) ? given : randomUUID();
  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
};
```

`src/platform/logger.ts`:
```ts
import pino, { type Logger } from "pino";
import type { RequestHandler } from "express";

export type { Logger };

export function createLogger(level = "info"): Logger {
  return pino({
    level,
    base: undefined,
    redact: { paths: ["req.headers.authorization", "req.headers.cookie", "*.secret", "*.signature"], censor: "[redacted]" },
  });
}

/** One line per request: id, key id when known, route, status, latency. Never a body, never a secret. */
export function requestLog(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      logger.info({
        request_id: res.locals.requestId as string,
        key_id: (res.locals.key as { id: string } | undefined)?.id ?? null,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        latency_ms: ms,
      });
    });
    next();
  };
}
```

`src/platform/error-handler.ts`:
```ts
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ApiError } from "../domain/errors.js";
import { mapDbError } from "../db/errors.js";
import type { Logger } from "./logger.js";

const TITLES: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict",
  413: "Payload Too Large", 415: "Unsupported Media Type", 422: "Unprocessable Content", 429: "Too Many Requests",
  500: "Internal Server Error", 503: "Service Unavailable",
};

export function sendProblem(res: import("express").Response, err: ApiError): void {
  const body = {
    type: `https://plutus.atilladev.com/errors/${err.code}`,
    title: TITLES[err.status] ?? "Error",
    status: err.status,
    detail: err.message,
    code: err.code,
    request_id: res.locals.requestId as string,
    ...(err.errors ? { errors: err.errors } : {}),
  };
  if (err.headers) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
  res.status(err.status).type("application/problem+json").send(JSON.stringify(body));
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  sendProblem(res, new ApiError(404, "not_found", "no such route"));
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof ApiError) return sendProblem(res, err);
    const mapped = mapDbError(err);
    if (mapped) return sendProblem(res, mapped);
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === "entity.parse.failed") return sendProblem(res, new ApiError(400, "validation_failed", "the request body is not valid JSON"));
    if (e?.type === "entity.too.large") return sendProblem(res, new ApiError(413, "payload_too_large", "the request body exceeds 64 KB"));
    logger.error({ request_id: res.locals.requestId as string, err: e?.message ?? String(err) }, "unhandled");
    sendProblem(res, new ApiError(500, "internal_error", "something went wrong on our side; quote the request id"));
  };
}
```

- [ ] **Step 3: Common schemas and the route registry**

`src/schemas/common.ts`:
```ts
import { z } from "zod";
import { MAX_AMOUNT } from "../domain/money.js";

export const AmountString = z.string().regex(/^(0|[1-9][0-9]*)$/, "a decimal string of minor units")
  .refine((s) => BigInt(s) <= MAX_AMOUNT, "exceeds the maximum amount")
  .refine((s) => s !== "0", "must be greater than zero")
  .meta({ description: "Integer minor units as a decimal string. 1 BTC is \"100000000\".", examples: ["1250"] });

export const Metadata = z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/), z.string().max(500))
  .refine((m) => Object.keys(m).length <= 20, "at most 20 keys").default({});

export const IdParam = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{32}$`));
export const AccountRef = z.string().regex(/^(acct_[0-9a-f]{32}|world:[A-Z]{3,5})$/, "an account id or world:ASSET");

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).optional(),
});

export const PagedOf = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), next_cursor: z.string().nullable() });

export const Problem = z.object({
  type: z.string(), title: z.string(), status: z.number(), detail: z.string(), code: z.string(), request_id: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export const Iso = z.string().meta({ description: "ISO 8601 UTC with milliseconds" });
```

`src/platform/route.ts`:
```ts
import type { Express, Request, Response, NextFunction } from "express";
import { z, type ZodType } from "zod";
import type { AppDeps } from "../deps.js";
import { ApiError, validation } from "../domain/errors.js";
import { decodeCursor, type Cursor } from "../domain/cursor.js";
import type { RateBucket } from "./ratelimit.js";

export interface AuthedKey { id: string; mode: "test" | "live"; scopes: string[]; prefix: string; last4: string }
export type Scope = "ledger:read" | "ledger:write" | "webhooks:manage" | "exchange:trade";

export interface RouteContext<P, Q, B> {
  params: P; query: Q; body: B;
  key: AuthedKey | null; requestId: string; ip: string;
  deps: AppDeps; req: Request; res: Response;
}

export interface RouteDef<P = unknown, Q = unknown, B = unknown, R = unknown> {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  summary: string;
  tag: string;
  auth: "none" | "bearer";
  scope?: Scope;
  limit?: RateBucket | "standard" | "none";
  idempotent?: boolean;
  params?: ZodType<P>;
  query?: ZodType<Q>;
  body?: ZodType<B>;
  response: ZodType<R>;
  status?: number;
  handler: (ctx: RouteContext<P, Q, B>) => Promise<R>;
}

export const ROUTE_REGISTRY: RouteDef[] = [];

export function defineRoute<P, Q, B, R>(def: RouteDef<P, Q, B, R>): RouteDef<P, Q, B, R> {
  return def;
}

/** Middleware slots filled by later tasks. Each is a factory so tests can swap them. */
export interface RouteMiddleware {
  auth: (def: RouteDef) => (req: Request, res: Response, next: NextFunction) => void;
  rateLimit: (def: RouteDef) => (req: Request, res: Response, next: NextFunction) => void;
  idempotency: (def: RouteDef) => (req: Request, res: Response, next: NextFunction) => void;
}

export function toExpressPath(path: string): string {
  return path.replaceAll(/\{([a-zA-Z_]+)\}/g, ":$1");
}

function issuesOf(err: z.ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

export function parsePage(query: { limit: number; cursor?: string }): { limit: number; cursor: Cursor | null } {
  if (query.cursor === undefined) return { limit: query.limit, cursor: null };
  const cursor = decodeCursor(query.cursor);
  if (!cursor) throw validation("cursor is not valid", [{ path: "cursor", message: "not a cursor this API issued" }]);
  return { limit: query.limit, cursor };
}

export function mountRoutes(app: Express, deps: AppDeps, routes: RouteDef[], mw: RouteMiddleware): void {
  for (const def of routes) {
    ROUTE_REGISTRY.push(def);
    const chain = [mw.auth(def), mw.rateLimit(def), mw.idempotency(def)];
    app[def.method](toExpressPath(def.path), ...chain, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const params = def.params ? def.params.safeParse(req.params) : { success: true as const, data: req.params };
        if (!params.success) throw new ApiError(404, "not_found", "no such resource", issuesOf(params.error));
        const query = def.query ? def.query.safeParse(req.query) : { success: true as const, data: req.query };
        if (!query.success) throw validation("query is invalid", issuesOf(query.error));
        let body: unknown = undefined;
        if (def.body) {
          if (!req.is("application/json") && req.method !== "GET") throw new ApiError(415, "unsupported_media_type", "send application/json");
          const parsed = def.body.safeParse(req.body ?? {});
          if (!parsed.success) throw validation("the request body is invalid", issuesOf(parsed.error));
          body = parsed.data;
        }
        const out = await def.handler({
          params: params.data as never, query: query.data as never, body: body as never,
          key: (res.locals.key as AuthedKey | undefined) ?? null,
          requestId: res.locals.requestId as string,
          ip: req.header("x-real-ip") ?? req.ip ?? "0.0.0.0",
          deps, req, res,
        });
        res.status(def.status ?? 200).json(out);
      } catch (err) {
        next(err);
      }
    });
  }
}
```

- [ ] **Step 4: Deps and the app**

`src/deps.ts`:
```ts
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { MemoryRateLimiter, type RateLimiter } from "./platform/ratelimit.js";
import { MemoryScheduler, type DeliveryScheduler } from "./platform/scheduler.js";
import { MemoryCache, type Cache } from "./platform/cache.js";
import { createLogger, type Logger } from "./platform/logger.js";

export interface AppDeps {
  pool: Pool;
  limiter: RateLimiter;
  scheduler: DeliveryScheduler;
  cache: Cache;
  logger: Logger;
  config: Config;
}

/** Production wiring. Tasks 7, 10 and 11 replace the memory doubles with Upstash when the variables are present. */
export function buildProductionDeps(env: NodeJS.ProcessEnv = process.env): AppDeps {
  const config = loadConfig(env);
  const logger = createLogger(config.NODE_ENV === "test" ? "silent" : "info");
  return {
    pool: createPool(config.DATABASE_URL),
    limiter: new MemoryRateLimiter(),
    scheduler: new MemoryScheduler(),
    cache: new MemoryCache(),
    logger,
    config,
  };
}
```

`src/app.ts`:
```ts
import express, { type Express } from "express";
import helmet from "helmet";
import type { AppDeps } from "./deps.js";
import { requestId } from "./platform/request-id.js";
import { requestLog } from "./platform/logger.js";
import { errorHandler, notFoundHandler } from "./platform/error-handler.js";
import { mountRoutes, type RouteDef, type RouteMiddleware } from "./platform/route.js";
import { healthRoutes } from "./routes/health.js";

const passThrough: RouteMiddleware = {
  auth: () => (_req, _res, next) => next(),
  rateLimit: () => (_req, _res, next) => next(),
  idempotency: () => (_req, _res, next) => next(),
};

export function createApp(deps: AppDeps, routes: RouteDef[] = [...healthRoutes], mw: RouteMiddleware = passThrough): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.locals.deps = deps;
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(requestId);
  app.use(requestLog(deps.logger));
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use((req, res, next) => {
    res.setTimeout(30_000, () => {
      if (!res.headersSent) res.status(503).type("application/problem+json").send(JSON.stringify({
        type: "https://plutus.atilladev.com/errors/internal_error", title: "Service Unavailable", status: 503,
        detail: "the request took too long", code: "internal_error", request_id: res.locals.requestId,
      }));
    });
    next();
  });
  app.use(express.static("public"));
  mountRoutes(app, deps, routes, mw);
  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
}
```

`src/routes/health.ts`:
```ts
import { z } from "zod";
import { defineRoute } from "../platform/route.js";

const Check = z.object({ ok: z.boolean(), latency_ms: z.number() });
const Health = z.object({ status: z.enum(["ok", "degraded"]), version: z.string(), checks: z.object({ postgres: Check, redis: Check }) });

async function timed(fn: () => Promise<unknown>): Promise<{ ok: boolean; latency_ms: number }> {
  const started = Date.now();
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 500))]);
    return { ok: true, latency_ms: Date.now() - started };
  } catch {
    return { ok: false, latency_ms: Date.now() - started };
  }
}

export const healthRoutes = [
  defineRoute({
    method: "get", path: "/health", summary: "Dependency checks", tag: "Meta", auth: "none", limit: "none",
    response: Health,
    handler: async ({ deps, res }) => {
      const postgres = await timed(() => deps.pool.query("select 1"));
      const redis = await timed(() => deps.cache.get("health"));
      const status = postgres.ok && redis.ok ? "ok" : "degraded";
      res.status(status === "ok" ? 200 : 503);
      return { status, version: deps.config.PLUTUS_VERSION, checks: { postgres, redis } };
    },
  }),
];
```

The handler sets the status on `res` before returning; `mountRoutes` then calls `res.status(def.status ?? 200)`, which would override it. Change that line in `mountRoutes` to `res.status(res.statusCode !== 200 ? res.statusCode : (def.status ?? 200)).json(out)`. This is the one place a handler chooses its own status.

`src/index.ts`:
```ts
import { createApp } from "./app.js";
import { buildProductionDeps } from "./deps.js";
import { allRoutes } from "./routes/index.js";
import { productionMiddleware } from "./platform/middleware.js";

const deps = buildProductionDeps();
const app = createApp(deps, allRoutes, productionMiddleware(deps));
export default app;
```

Create `src/routes/index.ts` exporting `allRoutes = [...healthRoutes]` and `src/platform/middleware.ts` exporting `productionMiddleware(deps): RouteMiddleware` returning the pass through for now. Tasks 6 to 8 fill both.

- [ ] **Step 5: Test helper and tests**

`tests/helpers/app.ts`:
```ts
import type { Express } from "express";
import { createApp } from "../../src/app.js";
import type { AppDeps } from "../../src/deps.js";
import { loadConfig } from "../../src/config.js";
import { testPool } from "./db.js";
import { MemoryRateLimiter } from "../../src/platform/ratelimit.js";
import { MemoryScheduler } from "../../src/platform/scheduler.js";
import { MemoryCache } from "../../src/platform/cache.js";
import { createLogger } from "../../src/platform/logger.js";
import { allRoutes } from "../../src/routes/index.js";
import { productionMiddleware } from "../../src/platform/middleware.js";

export async function makeTestApp(overrides: Partial<AppDeps> = {}): Promise<{ app: Express; deps: AppDeps; scheduler: MemoryScheduler; limiter: MemoryRateLimiter }> {
  const scheduler = new MemoryScheduler();
  const limiter = new MemoryRateLimiter();
  const deps: AppDeps = {
    pool: testPool(),
    limiter,
    scheduler,
    cache: new MemoryCache(),
    logger: createLogger("silent"),
    config: loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test", CRON_SECRET: "test-cron-secret-0123456789", PUBLIC_BASE_URL: "http://localhost:3000" }),
    ...overrides,
  };
  const app = createApp(deps, allRoutes, productionMiddleware(deps));
  return { app, deps, scheduler, limiter };
}
```

`tests/unit/route.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { toExpressPath, parsePage } from "../../src/platform/route.js";
import { encodeCursor } from "../../src/domain/cursor.js";

describe("route helpers", () => {
  it("converts OpenAPI paths to Express paths", () => {
    expect(toExpressPath("/v1/ledgers/{id}/holds/{holdId}")).toBe("/v1/ledgers/:id/holds/:holdId");
  });
  it("parses pages and rejects a forged cursor", () => {
    expect(parsePage({ limit: 5 })).toEqual({ limit: 5, cursor: null });
    expect(parsePage({ limit: 5, cursor: encodeCursor({ t: "x", id: "y" }) })).toEqual({ limit: 5, cursor: { t: "x", id: "y" } });
    expect(() => parsePage({ limit: 5, cursor: "zzz" })).toThrow();
  });
});
```

`tests/integration/platform.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";

describe("platform", () => {
  it("health reports both dependencies and a version", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.checks.postgres.ok).toBe(true);
    expect(res.body.version).toBe("dev");
    expect(res.headers["x-request-id"]).toMatch(/[0-9a-f-]{36}/);
  });
  it("echoes a safe request id and ignores an unsafe one", async () => {
    const { app } = await makeTestApp();
    expect((await request(app).get("/health").set("X-Request-Id", "abc-123-def")).headers["x-request-id"]).toBe("abc-123-def");
    expect((await request(app).get("/health").set("X-Request-Id", "<script>")).headers["x-request-id"]).not.toBe("<script>");
  });
  it("answers unknown routes and bad JSON as problem details with no stack", async () => {
    const { app } = await makeTestApp();
    const nf = await request(app).get("/nope");
    expect(nf.status).toBe(404);
    expect(nf.headers["content-type"]).toContain("application/problem+json");
    expect(nf.body.code).toBe("not_found");
    expect(nf.body.request_id).toBeTruthy();
    const bad = await request(app).post("/health").set("Content-Type", "application/json").send("{not json");
    expect([400, 404]).toContain(bad.status);
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.ts:\d+/);
  });
  it("sends security headers and no x-powered-by", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
```

- [ ] **Step 6: Run, fix, commit**

Run: `npm run build && npx vitest run tests/unit tests/integration`
Expected: green. If `res.locals.requestId` typing complains, add `declare global { namespace Express { interface Locals { requestId: string; key?: import("./platform/route.js").AuthedKey } } }` in a new `src/types/express.d.ts` included by tsconfig.

```bash
git add -A
git commit -m "Request ids, structured logs, problem details, and a route registry the docs are built from"
```

---

### Task 6: Keys and bearer auth

**Files:**
- Create: `src/db/keys.ts`, `src/platform/auth.ts`, `src/schemas/keys.ts`, `src/routes/keys.ts`, `src/routes/assets.ts`, `scripts/key-live.ts`
- Modify: `src/platform/middleware.ts`, `src/routes/index.ts`
- Create: `tests/helpers/keys.ts`
- Test: `tests/unit/keys.test.ts`, `tests/integration/keys.test.ts`

**Interfaces:**
- Produces: `generateSecret(mode): { secret: string; hash: Buffer; prefix: string; last4: string }`, `hashSecret(secret): Buffer` in `src/platform/auth.ts`; `bearerAuth(def: RouteDef): RequestHandler` that sets `res.locals.key` or throws `unauthorized`, and enforces `def.scope` with `forbidden_scope`.
- Produces in `src/db/keys.ts`: `insertKey(c, row)`, `findKeyBySecretHash(c, hash): Promise<KeyRow | null>` (only unrevoked, unexpired), `touchKey(c, id)`, `rotateKey(c, oldId, newRow)`, `countMintsByIp` is not needed (rate limiter does it).
- Produces: `mintKey(app): Promise<{ id: string; secret: string }>` and `bearer(secret)` helpers in `tests/helpers/keys.ts`.
- Routes: `POST /v1/keys`, `GET /v1/keys/me`, `POST /v1/keys/rotate`, `GET /v1/assets`.

- [ ] **Step 1: Failing tests**

`tests/unit/keys.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { generateSecret, hashSecret } from "../../src/platform/auth.js";

describe("secrets", () => {
  it("makes a prefixed base62 secret and a stable hash", () => {
    const k = generateSecret("test");
    expect(k.secret).toMatch(/^pl_test_[0-9A-Za-z]{43,44}$/);
    expect(k.prefix).toBe("pl_test");
    expect(k.last4).toBe(k.secret.slice(-4));
    expect(hashSecret(k.secret).equals(k.hash)).toBe(true);
    expect(hashSecret(k.secret + "x").equals(k.hash)).toBe(false);
  });
});
```

`tests/integration/keys.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";

describe("keys", () => {
  it("mints a sandbox key once and never shows the secret again", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).post("/v1/keys").send();
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^pl_test_/);
    expect(res.body.mode).toBe("test");
    expect(res.body.scopes).toEqual(["ledger:read", "ledger:write", "webhooks:manage", "exchange:trade"]);
    const me = await request(app).get("/v1/keys/me").set("Authorization", `Bearer ${res.body.secret}`);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(res.body.id);
    expect(me.body.secret).toBeUndefined();
    expect(me.body.last4).toBe(res.body.secret.slice(-4));
  });
  it("refuses missing, malformed and unknown keys, and never says which", async () => {
    const { app } = await makeTestApp();
    for (const header of [undefined, "Bearer", "Bearer nope", "Basic abc", `Bearer pl_test_${"a".repeat(43)}`]) {
      const r = header ? request(app).get("/v1/keys/me").set("Authorization", header) : request(app).get("/v1/keys/me");
      const res = await r;
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("unauthorized");
      expect(res.body.detail).not.toMatch(/unknown|revoked|expired/);
    }
  });
  it("rotates: the new secret works, the old one dies after the grace period", async () => {
    const { app, deps } = await makeTestApp();
    const first = (await request(app).post("/v1/keys").send()).body;
    const rot = await request(app).post("/v1/keys/rotate").set("Authorization", `Bearer ${first.secret}`).send();
    expect(rot.status).toBe(201);
    expect(rot.body.id).toBe(first.id);
    expect(rot.body.secret).not.toBe(first.secret);
    expect((await request(app).get("/v1/keys/me").set("Authorization", `Bearer ${rot.body.secret}`)).status).toBe(200);
    expect((await request(app).get("/v1/keys/me").set("Authorization", `Bearer ${first.secret}`)).status).toBe(200);
    await deps.pool.query("update api_keys set expires_at = now() - interval '1 second' where id = $1 and expires_at is not null", [first.id]);
    expect((await request(app).get("/v1/keys/me").set("Authorization", `Bearer ${first.secret}`)).status).toBe(401);
  });
  it("lists assets without a key", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/v1/assets");
    expect(res.status).toBe(200);
    expect(res.body.data.map((a: { code: string }) => a.code)).toEqual(["BTC", "ETH", "GHS", "HKD", "USD", "USDT"]);
  });
});
```

- [ ] **Step 2: Implement**

Rotation keeps the same `id`: the row gets a new `secret_hash`, and the old hash moves to a second row that shares nothing but a fifteen minute `expires_at` and `rotated_to` pointing at the id. Simplest correct design: store one row per secret in a small `api_key_secrets` table? No. Keep it in `api_keys`: insert a new row with `id` = `key_...` new id? That changes the id, which the spec forbids. So use this: `api_keys` keeps the current secret; a companion table `api_key_old_secrets (secret_hash bytea primary key, key_id text, expires_at timestamptz)` holds retiring secrets. Add it in this task as migration `0006_key_rotation.sql` (renumber the later migrations in this plan by one: idempotency becomes 0007, webhooks 0008).

`db/migrations/0006_key_rotation.sql`:
```sql
create table api_key_old_secrets (
  secret_hash bytea primary key,
  key_id text not null references api_keys(id) on delete cascade,
  expires_at timestamptz not null
);
```

`src/platform/auth.ts`:
```ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { ApiError, unauthorized } from "../domain/errors.js";
import { findKeyBySecretHash, touchKey } from "../db/keys.js";
import type { AppDeps } from "../deps.js";
import type { RouteDef, AuthedKey } from "./route.js";
export type { AuthedKey } from "./route.js";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62(bytes: Buffer): string {
  let n = BigInt("0x" + bytes.toString("hex"));
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 62n)] + out; n /= 62n; }
  return out;
}

export function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function generateSecret(mode: "test" | "live"): { secret: string; hash: Buffer; prefix: string; last4: string } {
  const prefix = mode === "live" ? "pl_live" : "pl_test";
  const secret = `${prefix}_${base62(randomBytes(32))}`;
  return { secret, hash: hashSecret(secret), prefix, last4: secret.slice(-4) };
}

const SECRET_RE = /^pl_(test|live)_[0-9A-Za-z]{40,48}$/;

export function bearerAuth(deps: AppDeps) {
  return (def: RouteDef): RequestHandler => async (req, res, next) => {
    try {
      if (def.auth === "none") return next();
      const header = req.header("authorization") ?? "";
      const [scheme, token] = header.split(" ");
      if (scheme !== "Bearer" || !token || !SECRET_RE.test(token)) throw unauthorized();
      const hash = hashSecret(token);
      const client = await deps.pool.connect();
      let key: AuthedKey | null = null;
      try {
        const row = await findKeyBySecretHash(client, hash);
        if (row && timingSafeEqual(row.secret_hash, hash)) {
          key = { id: row.id, mode: row.mode, scopes: row.scopes, prefix: row.prefix, last4: row.last4 };
          await touchKey(client, row.id);
        }
      } finally {
        client.release();
      }
      if (!key) throw unauthorized();
      if (def.scope && !key.scopes.includes(def.scope)) throw new ApiError(403, "forbidden_scope", `this key lacks the ${def.scope} scope`);
      res.locals.key = key;
      next();
    } catch (err) {
      next(err);
    }
  };
}
```

`src/db/keys.ts`:
```ts
import type { PoolClient } from "pg";

export interface KeyRow { id: string; secret_hash: Buffer; prefix: string; last4: string; mode: "test" | "live"; scopes: string[]; created_at: Date; last_used_at: Date | null; expires_at: Date | null; revoked_at: Date | null }

export async function insertKey(c: PoolClient, row: { id: string; secretHash: Buffer; prefix: string; last4: string; mode: "test" | "live"; scopes: string[] }): Promise<KeyRow> {
  const { rows } = await c.query<KeyRow>(
    "insert into api_keys (id, secret_hash, prefix, last4, mode, scopes) values ($1, $2, $3, $4, $5, $6) returning *",
    [row.id, row.secretHash, row.prefix, row.last4, row.mode, row.scopes]);
  return rows[0] as KeyRow;
}

/** The current secret, or a retiring one still inside its grace period. */
export async function findKeyBySecretHash(c: PoolClient, hash: Buffer): Promise<KeyRow | null> {
  const { rows } = await c.query<KeyRow>(
    `select k.*, $1::bytea as secret_hash from api_keys k
     where k.revoked_at is null and (
       k.secret_hash = $1
       or exists (select 1 from api_key_old_secrets o where o.secret_hash = $1 and o.key_id = k.id and o.expires_at > now()))
     limit 1`, [hash]);
  return rows[0] ?? null;
}

export async function getKey(c: PoolClient, id: string): Promise<KeyRow | null> {
  const { rows } = await c.query<KeyRow>("select * from api_keys where id = $1", [id]);
  return rows[0] ?? null;
}

export async function touchKey(c: PoolClient, id: string): Promise<void> {
  await c.query("update api_keys set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')", [id]);
}

export async function rotateKey(c: PoolClient, id: string, next: { secretHash: Buffer; last4: string }): Promise<void> {
  await c.query("insert into api_key_old_secrets (secret_hash, key_id, expires_at) select secret_hash, id, now() + interval '15 minutes' from api_keys where id = $1", [id]);
  await c.query("update api_keys set secret_hash = $2, last4 = $3 where id = $1", [id, next.secretHash, next.last4]);
}
```

`src/schemas/keys.ts`:
```ts
import { z } from "zod";
import { Iso } from "./common.js";

export const KeyPublic = z.object({
  id: z.string(), mode: z.enum(["test", "live"]), scopes: z.array(z.string()), prefix: z.string(), last4: z.string(),
  created_at: Iso, last_used_at: Iso.nullable(),
});
export const KeyMinted = KeyPublic.extend({ secret: z.string().meta({ description: "Shown exactly once." }) });
export const Asset = z.object({ code: z.string(), name: z.string(), exponent: z.number().int(), kind: z.enum(["fiat", "crypto"]) });
```

`src/routes/keys.ts`:
```ts
import { z } from "zod";
import { defineRoute } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { newId } from "../domain/ids.js";
import { generateSecret } from "../platform/auth.js";
import { insertKey, getKey, rotateKey } from "../db/keys.js";
import { KeyMinted, KeyPublic } from "../schemas/keys.js";
import { notFound } from "../domain/errors.js";

const ALL_SCOPES = ["ledger:read", "ledger:write", "webhooks:manage", "exchange:trade"];

const publicOf = (k: { id: string; mode: "test" | "live"; scopes: string[]; prefix: string; last4: string; created_at: Date; last_used_at: Date | null }) => ({
  id: k.id, mode: k.mode, scopes: k.scopes, prefix: k.prefix, last4: k.last4,
  created_at: k.created_at.toISOString(), last_used_at: k.last_used_at?.toISOString() ?? null,
});

export const keyRoutes = [
  defineRoute({
    method: "post", path: "/v1/keys", summary: "Mint a sandbox key", tag: "Keys", auth: "none", limit: "mint", status: 201,
    response: KeyMinted,
    handler: async ({ deps }) => {
      const s = generateSecret("test");
      const row = await withTx(deps.pool, (c) => insertKey(c, { id: newId("key"), secretHash: s.hash, prefix: s.prefix, last4: s.last4, mode: "test", scopes: ALL_SCOPES }));
      return { ...publicOf(row), secret: s.secret };
    },
  }),
  defineRoute({
    method: "get", path: "/v1/keys/me", summary: "The calling key", tag: "Keys", auth: "bearer",
    response: KeyPublic,
    handler: async ({ deps, key }) => {
      const row = await withTx(deps.pool, (c) => getKey(c, key!.id));
      if (!row) throw notFound("key");
      return publicOf(row);
    },
  }),
  defineRoute({
    method: "post", path: "/v1/keys/rotate", summary: "Rotate the secret. The old one works for fifteen more minutes", tag: "Keys", auth: "bearer", status: 201,
    body: z.object({}).optional(),
    response: KeyMinted,
    handler: async ({ deps, key }) => {
      const s = generateSecret(key!.mode);
      const row = await withTx(deps.pool, async (c) => { await rotateKey(c, key!.id, { secretHash: s.hash, last4: s.last4 }); return getKey(c, key!.id); });
      if (!row) throw notFound("key");
      return { ...publicOf(row), secret: s.secret };
    },
  }),
];
```

`src/routes/assets.ts`:
```ts
import { z } from "zod";
import { defineRoute } from "../platform/route.js";
import { Asset } from "../schemas/keys.js";

export const assetRoutes = [
  defineRoute({
    method: "get", path: "/v1/assets", summary: "The fixed asset table", tag: "Assets", auth: "none", limit: "none",
    response: z.object({ data: z.array(Asset) }),
    handler: async ({ deps }) => {
      const { rows } = await deps.pool.query<{ code: string; name: string; exponent: number; kind: "fiat" | "crypto" }>("select code, name, exponent, kind from assets order by code");
      return { data: rows };
    },
  }),
];
```

Update `src/routes/index.ts` to `export const allRoutes = [...healthRoutes, ...assetRoutes, ...keyRoutes]` and `src/platform/middleware.ts` to `productionMiddleware(deps)` returning `{ auth: bearerAuth(deps), rateLimit: () => passThrough, idempotency: () => passThrough }`.

`tests/helpers/keys.ts`:
```ts
import type { Express } from "express";
import request from "supertest";

export async function mintKey(app: Express): Promise<{ id: string; secret: string }> {
  const res = await request(app).post("/v1/keys").send();
  if (res.status !== 201) throw new Error(`mint failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id, secret: res.body.secret };
}
export const bearer = (secret: string): Record<string, string> => ({ Authorization: `Bearer ${secret}` });
```

`scripts/key-live.ts`:
```ts
import { existsSync } from "node:fs";
import pg from "pg";
import { generateSecret } from "../src/platform/auth.js";
import { newId } from "../src/domain/ids.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) { process.stderr.write("DATABASE_URL_UNPOOLED is required\n"); process.exit(1); }
const client = new pg.Client({ connectionString: url });
await client.connect();
const s = generateSecret("live");
const id = newId("key");
await client.query("insert into api_keys (id, secret_hash, prefix, last4, mode, scopes) values ($1, $2, $3, $4, 'live', '{ledger:read,ledger:write,webhooks:manage,exchange:trade}')", [id, s.hash, s.prefix, s.last4]);
await client.end();
process.stdout.write(`id: ${id}\nsecret (shown once, store it now): ${s.secret}\n`);
```

- [ ] **Step 3: Run, commit**

Run: `npm run build && npx vitest run`
Expected: green, including the earlier suites.

```bash
git add -A
git commit -m "Sandbox keys anyone can mint, bearer auth with scopes, and rotation with a grace period"
```

---

### Task 7: Rate limits with headers, failing closed

**Files:**
- Modify: `src/platform/ratelimit.ts` (add `UpstashRateLimiter` and `rateLimitMiddleware`), `src/platform/middleware.ts`, `src/deps.ts`
- Test: `tests/unit/ratelimit.test.ts`, `tests/integration/ratelimit.test.ts`

**Interfaces:**
- Produces: `class UpstashRateLimiter implements RateLimiter` built from `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`; `rateLimitMiddleware(deps)(def): RequestHandler`.
- Bucket choice per route: `def.limit === "none"` skips; `"mint"` and `"verify"` are literal buckets; `"standard"` (the default when `auth: "bearer"`) picks `sandbox` or `live` from `res.locals.key.mode`. Identifier is the key id when authenticated, otherwise the client IP.
- Every limited response carries `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds until reset). A refusal is 429 `rate_limited` with `Retry-After`.
- A limiter error (Redis unreachable) becomes 503 `rate_limiter_unavailable`.

- [ ] **Step 1: Failing tests**

`tests/unit/ratelimit.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { MemoryRateLimiter } from "../../src/platform/ratelimit.js";

describe("MemoryRateLimiter", () => {
  it("allows the configured points inside the window and refuses the next", async () => {
    let t = 1_000_000;
    const l = new MemoryRateLimiter(() => t);
    for (let i = 0; i < 5; i++) expect((await l.limit("mint", "1.2.3.4")).ok).toBe(true);
    const sixth = await l.limit("mint", "1.2.3.4");
    expect(sixth.ok).toBe(false);
    expect(sixth.remaining).toBe(0);
    t += 3600 * 1000 + 1;
    expect((await l.limit("mint", "1.2.3.4")).ok).toBe(true);
  });
  it("keeps identifiers apart", async () => {
    const l = new MemoryRateLimiter();
    for (let i = 0; i < 5; i++) await l.limit("mint", "a");
    expect((await l.limit("mint", "b")).ok).toBe(true);
  });
});
```

`tests/integration/ratelimit.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import type { RateLimiter } from "../../src/platform/ratelimit.js";

describe("rate limits", () => {
  it("limits minting per IP and says when to come back", async () => {
    const { app } = await makeTestApp();
    for (let i = 0; i < 5; i++) expect((await request(app).post("/v1/keys").set("X-Real-IP", "9.9.9.9").send()).status).toBe(201);
    const res = await request(app).post("/v1/keys").set("X-Real-IP", "9.9.9.9").send();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("rate_limited");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.headers["ratelimit-limit"]).toBe("5");
    expect((await request(app).post("/v1/keys").set("X-Real-IP", "8.8.8.8").send()).status).toBe(201);
  });
  it("limits a sandbox key at sixty a minute with headers on every response", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const first = await request(app).get("/v1/keys/me").set(bearer(k.secret));
    expect(first.headers["ratelimit-limit"]).toBe("60");
    expect(first.headers["ratelimit-remaining"]).toBe("59");
    for (let i = 0; i < 59; i++) await request(app).get("/v1/keys/me").set(bearer(k.secret));
    expect((await request(app).get("/v1/keys/me").set(bearer(k.secret))).status).toBe(429);
  });
  it("fails closed when the limiter is down", async () => {
    const broken: RateLimiter = { limit: async () => { throw new Error("redis unreachable"); } };
    const { app } = await makeTestApp({ limiter: broken });
    const res = await request(app).post("/v1/keys").send();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("rate_limiter_unavailable");
  });
});
```

- [ ] **Step 2: Implement**

Append to `src/platform/ratelimit.ts`:
```ts
import type { RequestHandler } from "express";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { ApiError } from "../domain/errors.js";
import type { AppDeps } from "../deps.js";
import type { RouteDef, AuthedKey } from "./route.js";

export class UpstashRateLimiter implements RateLimiter {
  private readonly limiters: Record<RateBucket, Ratelimit>;
  constructor(url: string, token: string) {
    const redis = new Redis({ url, token });
    const make = (b: RateBucket) => new Ratelimit({
      redis, prefix: `plutus:rl:${b}`,
      limiter: Ratelimit.slidingWindow(RATE_RULES[b].points, `${RATE_RULES[b].windowSeconds} s`),
    });
    this.limiters = { mint: make("mint"), sandbox: make("sandbox"), live: make("live"), verify: make("verify") };
  }
  async limit(bucket: RateBucket, id: string): Promise<RateResult> {
    const r = await this.limiters[bucket].limit(id);
    return { ok: r.success, limit: r.limit, remaining: r.remaining, resetAt: r.reset };
  }
}

export function rateLimitMiddleware(deps: AppDeps) {
  return (def: RouteDef): RequestHandler => async (req, res, next) => {
    try {
      const mode = def.limit ?? (def.auth === "bearer" ? "standard" : "none");
      if (mode === "none") return next();
      const key = res.locals.key as AuthedKey | undefined;
      const bucket: RateBucket = mode === "standard" ? (key?.mode === "live" ? "live" : "sandbox") : mode;
      const id = key?.id ?? req.header("x-real-ip") ?? req.ip ?? "unknown";
      let result: RateResult;
      try {
        result = await Promise.race([
          deps.limiter.limit(bucket, id),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("limiter timeout")), 500)),
        ]);
      } catch (err) {
        deps.logger.error({ err: (err as Error).message }, "rate limiter unavailable");
        throw new ApiError(503, "rate_limiter_unavailable", "the rate limiter is unreachable; try again shortly");
      }
      const resetSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
      res.setHeader("RateLimit-Limit", String(result.limit));
      res.setHeader("RateLimit-Remaining", String(result.remaining));
      res.setHeader("RateLimit-Reset", String(resetSeconds));
      if (!result.ok) throw new ApiError(429, "rate_limited", `limit of ${result.limit} per window reached`, undefined, { "Retry-After": String(resetSeconds) });
      next();
    } catch (err) {
      next(err);
    }
  };
}
```

`Math.ceil` here is on seconds, not money, but the house rule bans the token in `src`. Replace it with integer arithmetic: `const msLeft = result.resetAt - Date.now(); const resetSeconds = msLeft <= 0 ? 1 : Math.trunc((msLeft + 999) / 1000);`. `Math.trunc` is not banned. Keep the ban strict rather than adding exceptions.

In `src/platform/middleware.ts`, set `rateLimit: rateLimitMiddleware(deps)`. In `src/deps.ts`, choose `new UpstashRateLimiter(url, token)` when both variables are present, else `MemoryRateLimiter`, and log one line saying which.

- [ ] **Step 3: Run, commit**

Run: `npm run build && npx vitest run`
Expected: green. If the sixty call test is slow, it is not; sixty supertest calls take well under a second.

```bash
git add -A
git commit -m "Rate limits per key and per IP, with the standard headers, failing closed"
```

---

### Task 8: Idempotency keys

**Files:**
- Create: `db/migrations/0007_idempotency.sql`, `src/db/idempotency.ts`, `src/platform/idempotency.ts`
- Modify: `src/platform/middleware.ts`
- Test: `tests/integration/idempotency.test.ts`

**Interfaces:**
- Produces: `idempotencyMiddleware(deps)(def): RequestHandler`. Applies only when `def.idempotent === true` and the request carries `Idempotency-Key` (1 to 255 characters) and `res.locals.key` is set. Stores `{ key_id, idem_key, fingerprint, status, response_status, response_body }` with a 24 hour expiry.
- Fingerprint: SHA256 of `${method}\n${path}\n${canonical body}` where the body is the raw parsed JSON re-serialised with `canonicalJson` (so key order does not matter).
- Replay returns the stored status and body with header `Idempotent-Replayed: true`. Same key with a different fingerprint: 409 `idempotency_key_reused`. Same key while the first is still `pending`: 409 `idempotency_in_flight`.

- [ ] **Step 1: Migration**

`db/migrations/0007_idempotency.sql`:
```sql
create table idempotency_keys (
  key_id text not null references api_keys(id) on delete cascade,
  idem_key text not null,
  fingerprint bytea not null,
  status text not null check (status in ('pending', 'done')),
  response_status int,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (key_id, idem_key)
);
create index idempotency_expires_idx on idempotency_keys (expires_at);
```

- [ ] **Step 2: Failing test**

`tests/integration/idempotency.test.ts` (uses the transfers route from Task 9, so write it now and run it after Task 9; until then run only the `rotate` case, which is a POST that Task 6 already marked `idempotent: true` in this task):
```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";

describe("idempotency", () => {
  it("replays the first response for the same key and body", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const h = { ...bearer(k.secret), "Idempotency-Key": "rot-1" };
    const a = await request(app).post("/v1/keys/rotate").set(h).send({});
    const b = await request(app).post("/v1/keys/rotate").set(h).send({});
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.secret).toBe(a.body.secret);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(a.headers["idempotent-replayed"]).toBeUndefined();
  });
  it("refuses the same key with a different body", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const l = (await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: "x" })).body;
    const h = { ...bearer(k.secret), "Idempotency-Key": "acct-1" };
    expect((await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "one" })).status).toBe(201);
    const res = await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "two" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("idempotency_key_reused");
  });
  it("scopes keys per API key and ignores requests without the header", async () => {
    const { app } = await makeTestApp();
    const k1 = await mintKey(app);
    const k2 = await mintKey(app);
    const a = await request(app).post("/v1/keys/rotate").set({ ...bearer(k1.secret), "Idempotency-Key": "same" }).send({});
    const b = await request(app).post("/v1/keys/rotate").set({ ...bearer(k2.secret), "Idempotency-Key": "same" }).send({});
    expect(a.body.secret).not.toBe(b.body.secret);
    const c = await request(app).post("/v1/keys/rotate").set(bearer(b.body.secret)).send({});
    const d = await request(app).post("/v1/keys/rotate").set(bearer(c.body.secret)).send({});
    expect(c.body.secret).not.toBe(d.body.secret);
  });
});
```

- [ ] **Step 3: Implement**

`src/db/idempotency.ts`:
```ts
import type { PoolClient } from "pg";

export interface IdemRow { key_id: string; idem_key: string; fingerprint: Buffer; status: "pending" | "done"; response_status: number | null; response_body: unknown }

/** Inserts a pending record. Returns the existing row instead if one is already there. */
export async function claim(c: PoolClient, keyId: string, idemKey: string, fingerprint: Buffer): Promise<{ claimed: boolean; row: IdemRow }> {
  const ins = await c.query<IdemRow>(
    `insert into idempotency_keys (key_id, idem_key, fingerprint, status, expires_at)
     values ($1, $2, $3, 'pending', now() + interval '24 hours')
     on conflict (key_id, idem_key) do nothing returning *`, [keyId, idemKey, fingerprint]);
  if (ins.rows[0]) return { claimed: true, row: ins.rows[0] };
  const { rows } = await c.query<IdemRow>("select * from idempotency_keys where key_id = $1 and idem_key = $2", [keyId, idemKey]);
  return { claimed: false, row: rows[0] as IdemRow };
}

export async function complete(c: PoolClient, keyId: string, idemKey: string, status: number, body: unknown): Promise<void> {
  await c.query("update idempotency_keys set status = 'done', response_status = $3, response_body = $4::jsonb where key_id = $1 and idem_key = $2",
    [keyId, idemKey, status, JSON.stringify(body)]);
}

export async function abandon(c: PoolClient, keyId: string, idemKey: string): Promise<void> {
  await c.query("delete from idempotency_keys where key_id = $1 and idem_key = $2 and status = 'pending'", [keyId, idemKey]);
}
```

`src/platform/idempotency.ts`:
```ts
import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { ApiError, validation } from "../domain/errors.js";
import { canonicalJson, type JsonValue } from "../domain/canonical.js";
import { claim, complete, abandon } from "../db/idempotency.js";
import type { AppDeps } from "../deps.js";
import type { RouteDef, AuthedKey } from "./route.js";

export function idempotencyMiddleware(deps: AppDeps) {
  return (def: RouteDef): RequestHandler => async (req, res, next) => {
    try {
      const idem = req.header("idempotency-key");
      const key = res.locals.key as AuthedKey | undefined;
      if (!def.idempotent || !idem || !key) return next();
      if (idem.length > 255) throw validation("Idempotency-Key must be 1 to 255 characters");
      let bodyCanonical = "";
      try { bodyCanonical = canonicalJson((req.body ?? {}) as JsonValue); } catch { bodyCanonical = JSON.stringify(req.body ?? {}); }
      const fingerprint = createHash("sha256").update(`${req.method}\n${req.path}\n${bodyCanonical}`).digest();
      const client = await deps.pool.connect();
      let claimed = false;
      try {
        const r = await claim(client, key.id, idem, fingerprint);
        claimed = r.claimed;
        if (!r.claimed) {
          if (!timingSafeEqual(r.row.fingerprint, fingerprint)) throw new ApiError(409, "idempotency_key_reused", "this Idempotency-Key was already used with a different request");
          if (r.row.status === "pending") throw new ApiError(409, "idempotency_in_flight", "a request with this Idempotency-Key is still being processed");
          res.setHeader("Idempotent-Replayed", "true");
          res.status(r.row.response_status ?? 200).json(r.row.response_body);
          return;
        }
      } finally {
        client.release();
      }
      // Capture the response this request produces and store it.
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        const status = res.statusCode;
        void (async () => {
          const c = await deps.pool.connect();
          try { if (status < 500) await complete(c, key.id, idem, status, body); else await abandon(c, key.id, idem); } finally { c.release(); }
        })().catch((err: unknown) => deps.logger.error({ err: (err as Error).message }, "idempotency store failed"));
        return originalJson(body);
      }) as typeof res.json;
      res.on("close", () => {
        if (claimed && !res.writableFinished) void deps.pool.connect().then((c) => abandon(c, key.id, idem).finally(() => c.release()));
      });
      next();
    } catch (err) {
      next(err);
    }
  };
}
```

Problem details responses do not go through `res.json` (they use `send`), so a 4xx error is not stored and the pending row is abandoned on close, which lets the client retry after fixing the request. Set `idempotent: true` on `POST /v1/keys/rotate` in `src/routes/keys.ts` and wire `idempotency: idempotencyMiddleware(deps)` in `src/platform/middleware.ts`.

- [ ] **Step 4: Run the first test only, commit**

Run: `npx vitest run tests/integration/idempotency.test.ts -t "replays"` and `npm run build`
Expected: the replay test passes; the other two fail on missing routes until Task 9, which is expected. Do not skip them; leave them red and say so in the report.

```bash
git add -A
git commit -m "Idempotency keys: replay the same answer, refuse a changed body, never pay twice"
```

---

### Task 9: The ledger routes: ledgers, accounts, transfers, holds, journal, events

**Files:**
- Create: `src/schemas/ledgers.ts`, `src/schemas/accounts.ts`, `src/schemas/transfers.ts`, `src/schemas/holds.ts`, `src/schemas/journal.ts`, `src/schemas/events.ts`
- Create: `src/routes/ledgers.ts`, `src/routes/accounts.ts`, `src/routes/transfers.ts`, `src/routes/holds.ts`, `src/routes/journal.ts`, `src/routes/events.ts`
- Create: `src/db/events.ts`, `src/platform/fanout.ts` (a no op hook this task; Task 11 fills it)
- Modify: `src/routes/index.ts`
- Test: `tests/integration/ledgers.test.ts`, `tests/integration/transfers.test.ts`, `tests/integration/holds.test.ts`, plus the two remaining cases in `tests/integration/idempotency.test.ts`

**Interfaces:**
- Produces: `afterCommit(deps, eventIds: string[]): Promise<void>` in `src/platform/fanout.ts`; every write route calls it after its transaction commits. This task's implementation logs and returns. Task 11 replaces the body.
- Produces: `listEvents(c, keyId, page, type?)`, `getEvent(c, keyId, id)` in `src/db/events.ts`.
- Produces zod schemas and `toApi` shapes: `LedgerOut`, `AccountOut` (with `available`), `TransferOut`, `HoldOut`, `JournalEntryOut`, `EventOut`.
- Response shapes:
  - Ledger: `{ id, name, next_seq, head_hash (hex), last_activity_at, created_at }`
  - Account: `{ id, ledger_id, asset, name, kind, balance, held, available, metadata, created_at }`
  - Transfer: `{ id, ledger_id, seq, memo, metadata, legs: [{ position, from, from_hold, to, asset, amount }], created_at }`
  - Hold: `{ id, ledger_id, account_id, asset, amount, remaining, status, expires_at, memo, metadata, created_at, closed_at }`
  - Journal entry: `{ seq, kind, entity_id, payload, prev_hash, hash, created_at }`
  - Event: `{ id, type, ledger_id, entity_id, data, created_at }`

- [ ] **Step 1: Failing tests**

`tests/integration/ledgers.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";

describe("ledgers and accounts", () => {
  it("creates, reads and lists ledgers, and never shows another key's ledger", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const other = await mintKey(app);
    const created = await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: "shop" });
    expect(created.status).toBe(201);
    expect(created.body.id).toMatch(/^ldg_[0-9a-f]{32}$/);
    expect(created.body.next_seq).toBe("1");
    expect(created.body.head_hash).toBe("0".repeat(64));
    expect((await request(app).get(`/v1/ledgers/${created.body.id}`).set(bearer(k.secret))).status).toBe(200);
    expect((await request(app).get(`/v1/ledgers/${created.body.id}`).set(bearer(other.secret))).status).toBe(404);
    const list = await request(app).get("/v1/ledgers").set(bearer(k.secret));
    expect(list.body.data.map((l: { id: string }) => l.id)).toEqual([created.body.id]);
    expect(list.body.next_cursor).toBeNull();
  });
  it("validates names and enforces the ten ledger ceiling", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const bad = await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: "" });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("validation_failed");
    expect(bad.body.errors[0].path).toBe("name");
    for (let i = 0; i < 10; i++) expect((await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: `l${i}` })).status).toBe(201);
    const over = await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: "eleven" });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe("sandbox_limit_reached");
    expect(over.body.detail).toContain("ledgers");
  });
  it("creates accounts with balance, held and available, and paginates newest first", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const l = (await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: "x" })).body;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(bearer(k.secret)).send({ asset: "GHS", name: `a${i}`, metadata: { note: "n" } });
      expect(a.status).toBe(201);
      expect(a.body).toMatchObject({ asset: "GHS", balance: "0", held: "0", available: "0", kind: "normal", metadata: { note: "n" } });
      ids.push(a.body.id);
    }
    const p1 = await request(app).get(`/v1/ledgers/${l.id}/accounts?limit=2`).set(bearer(k.secret));
    expect(p1.body.data.map((a: { id: string }) => a.id)).toEqual([ids[2], ids[1]]);
    expect(p1.body.next_cursor).toBeTruthy();
    const p2 = await request(app).get(`/v1/ledgers/${l.id}/accounts?limit=2&cursor=${encodeURIComponent(p1.body.next_cursor)}`).set(bearer(k.secret));
    expect(p2.body.data.map((a: { id: string }) => a.id)).toEqual([ids[0]]);
    expect(p2.body.next_cursor).toBeNull();
    expect((await request(app).get(`/v1/ledgers/${l.id}/accounts?cursor=garbage`).set(bearer(k.secret))).status).toBe(422);
  });
  it("rejects an unknown asset, bad metadata, and a JSON number amount later", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const l = (await request(app).post("/v1/ledgers").set(bearer(k.secret)).send({ name: "x" })).body;
    expect((await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(bearer(k.secret)).send({ asset: "XXX", name: "a" })).status).toBe(422);
    expect((await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(bearer(k.secret)).send({ asset: "GHS", name: "a", metadata: { "bad key!": "x" } })).status).toBe(422);
  });
});
```

`tests/integration/transfers.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";

async function seed(app: Parameters<typeof request>[0]) {
  const k = await mintKey(app);
  const h = bearer(k.secret);
  const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "x" })).body;
  const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "USD", name: "a" })).body;
  const b = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "USD", name: "b" })).body;
  return { k, h, l, a, b };
}

describe("transfers over HTTP", () => {
  it("funds from the world, moves money, reads back with legs, and lists by account", async () => {
    const { app } = await makeTestApp();
    const { h, l, a, b } = await seed(app);
    const fund = await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:USD", to: a.id, asset: "USD", amount: "5000" }], memo: "deposit" });
    expect(fund.status).toBe(201);
    expect(fund.body.seq).toBe("1");
    expect(fund.body.legs[0]).toMatchObject({ position: 0, to: a.id, asset: "USD", amount: "5000", from_hold: null });
    expect(fund.body.legs[0].from).toMatch(/^acct_/);
    const move = await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: a.id, to: b.id, asset: "USD", amount: "1250" }] });
    expect(move.status).toBe(201);
    const acc = await request(app).get(`/v1/ledgers/${l.id}/accounts/${a.id}`).set(h);
    expect(acc.body).toMatchObject({ balance: "3750", held: "0", available: "3750" });
    const one = await request(app).get(`/v1/ledgers/${l.id}/transfers/${move.body.id}`).set(h);
    expect(one.body.legs).toHaveLength(1);
    const byB = await request(app).get(`/v1/ledgers/${l.id}/transfers?account=${b.id}`).set(h);
    expect(byB.body.data.map((t: { id: string }) => t.id)).toEqual([move.body.id]);
  });
  it("returns problem details for an overdraft and for a number amount", async () => {
    const { app } = await makeTestApp();
    const { h, l, a, b } = await seed(app);
    const od = await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: a.id, to: b.id, asset: "USD", amount: "1" }] });
    expect(od.status).toBe(409);
    expect(od.body.code).toBe("insufficient_funds");
    expect(od.body.detail).toContain("leg 0");
    const num = await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:USD", to: a.id, asset: "USD", amount: 100 }] });
    expect(num.status).toBe(422);
    expect(num.body.errors[0].path).toBe("legs.0.amount");
  });
  it("cannot touch another key's ledger", async () => {
    const { app } = await makeTestApp();
    const mine = await seed(app);
    const theirs = await seed(app);
    const res = await request(app).post(`/v1/ledgers/${theirs.l.id}/transfers`).set(mine.h).send({ legs: [{ from: "world:USD", to: theirs.a.id, asset: "USD", amount: "1" }] });
    expect(res.status).toBe(404);
  });
  it("reads the journal oldest first with a since cursor", async () => {
    const { app } = await makeTestApp();
    const { h, l, a } = await seed(app);
    for (let i = 0; i < 3; i++) await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:USD", to: a.id, asset: "USD", amount: "10" }] });
    const j = await request(app).get(`/v1/ledgers/${l.id}/journal?since=1`).set(h);
    expect(j.body.data.map((e: { seq: string }) => e.seq)).toEqual(["2", "3"]);
    expect(j.body.data[0].kind).toBe("transfer.posted");
    expect(j.body.data[0].hash).toMatch(/^[0-9a-f]{64}$/);
    const ev = await request(app).get("/v1/events?type=transfer.posted").set(h);
    expect(ev.body.data.length).toBe(3);
  });
});
```

`tests/integration/holds.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";

describe("holds over HTTP", () => {
  it("creates, captures with a remainder released, and expires lazily on read", async () => {
    const { app, deps } = await makeTestApp();
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "x" })).body;
    const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "HKD", name: "a" })).body;
    const b = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "HKD", name: "b" })).body;
    await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:HKD", to: a.id, asset: "HKD", amount: "10000" }] });
    const hold = await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: a.id, amount: "4000", expires_in_seconds: 60 });
    expect(hold.status).toBe(201);
    expect(hold.body).toMatchObject({ status: "open", amount: "4000", remaining: "4000" });
    expect((await request(app).get(`/v1/ledgers/${l.id}/accounts/${a.id}`).set(h)).body).toMatchObject({ held: "4000", available: "6000" });
    const cap = await request(app).post(`/v1/ledgers/${l.id}/holds/${hold.body.id}/capture`).set(h).send({ to: b.id, amount: "1500", release_remainder: true });
    expect(cap.status).toBe(200);
    expect(cap.body.hold.status).toBe("captured");
    expect(cap.body.transfer.legs[0].from_hold).toBe(hold.body.id);
    expect((await request(app).get(`/v1/ledgers/${l.id}/accounts/${a.id}`).set(h)).body).toMatchObject({ balance: "8500", held: "0", available: "8500" });
    const again = await request(app).post(`/v1/ledgers/${l.id}/holds/${hold.body.id}/release`).set(h).send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("hold_not_open");
    const h2 = (await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: a.id, amount: "100", expires_in_seconds: 60 })).body;
    await deps.pool.query("update holds set expires_at = now() - interval '1 second' where id = $1", [h2.id]);
    expect((await request(app).get(`/v1/ledgers/${l.id}/holds/${h2.id}`).set(h)).body.status).toBe("expired");
    expect((await request(app).get(`/v1/ledgers/${l.id}/accounts/${a.id}`).set(h)).body.held).toBe("0");
  });
  it("validates expiry bounds and refuses a capture beyond remaining", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "x" })).body;
    const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "HKD", name: "a" })).body;
    const b = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "HKD", name: "b" })).body;
    await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:HKD", to: a.id, asset: "HKD", amount: "100" }] });
    expect((await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: a.id, amount: "1", expires_in_seconds: 8 * 24 * 3600 })).status).toBe(422);
    const hold = (await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: a.id, amount: "50" })).body;
    const over = await request(app).post(`/v1/ledgers/${l.id}/holds/${hold.id}/capture`).set(h).send({ to: b.id, amount: "51" });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe("insufficient_funds");
  });
});
```

- [ ] **Step 2: Schemas**

`src/schemas/ledgers.ts`:
```ts
import { z } from "zod";
import { Iso } from "./common.js";
export const LedgerCreate = z.object({ name: z.string().min(1).max(80) });
export const LedgerOut = z.object({ id: z.string(), name: z.string(), next_seq: z.string(), head_hash: z.string(), last_activity_at: Iso, created_at: Iso });
```

`src/schemas/accounts.ts`:
```ts
import { z } from "zod";
import { Iso, Metadata } from "./common.js";
export const AccountCreate = z.object({ asset: z.string().regex(/^[A-Z]{3,5}$/), name: z.string().min(1).max(80), metadata: Metadata });
export const AccountOut = z.object({
  id: z.string(), ledger_id: z.string(), asset: z.string(), name: z.string(), kind: z.enum(["normal", "world"]),
  balance: z.string(), held: z.string(), available: z.string(), metadata: z.record(z.string(), z.string()), created_at: Iso,
});
```

`src/schemas/transfers.ts`:
```ts
import { z } from "zod";
import { AmountString, AccountRef, Iso, Metadata } from "./common.js";
export const LegIn = z.object({
  from: AccountRef.optional(), from_hold: z.string().regex(/^hold_[0-9a-f]{32}$/).optional(),
  to: AccountRef, asset: z.string().regex(/^[A-Z]{3,5}$/), amount: AmountString,
}).refine((l) => (l.from ? 1 : 0) + (l.from_hold ? 1 : 0) === 1, { message: "exactly one of from or from_hold", path: ["from"] });
export const TransferCreate = z.object({ legs: z.array(LegIn).min(1).max(20), memo: z.string().max(200).default(""), metadata: Metadata });
export const LegOut = z.object({ position: z.number().int(), from: z.string(), from_hold: z.string().nullable(), to: z.string(), asset: z.string(), amount: z.string() });
export const TransferOut = z.object({ id: z.string(), ledger_id: z.string(), seq: z.string(), memo: z.string(), metadata: z.record(z.string(), z.string()), legs: z.array(LegOut), created_at: Iso });
```

`src/schemas/holds.ts`:
```ts
import { z } from "zod";
import { AmountString, Iso, Metadata } from "./common.js";
import { TransferOut } from "./transfers.js";
export const HoldCreate = z.object({
  account: z.string().regex(/^acct_[0-9a-f]{32}$/), amount: AmountString,
  expires_in_seconds: z.number().int().min(1).max(7 * 24 * 3600).default(900), memo: z.string().max(200).default(""), metadata: Metadata,
});
export const HoldCapture = z.object({ to: z.string().regex(/^(acct_[0-9a-f]{32}|world:[A-Z]{3,5})$/), amount: AmountString.optional(), release_remainder: z.boolean().default(false) });
export const HoldOut = z.object({
  id: z.string(), ledger_id: z.string(), account_id: z.string(), asset: z.string(), amount: z.string(), remaining: z.string(),
  status: z.enum(["open", "captured", "released", "expired"]), expires_at: Iso, memo: z.string(), metadata: z.record(z.string(), z.string()),
  created_at: Iso, closed_at: Iso.nullable(),
});
export const HoldCaptureOut = z.object({ hold: HoldOut, transfer: TransferOut });
export const HoldReleaseOut = z.object({ hold: HoldOut, released: z.string() });
```

`src/schemas/journal.ts` and `src/schemas/events.ts`:
```ts
import { z } from "zod";
import { Iso } from "./common.js";
export const JournalEntryOut = z.object({ seq: z.string(), kind: z.string(), entity_id: z.string(), payload: z.record(z.string(), z.unknown()), prev_hash: z.string(), hash: z.string(), created_at: Iso });
export const JournalQuery = z.object({ since: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) });
```
```ts
import { z } from "zod";
import { Iso, PageQuery } from "./common.js";
export const EventOut = z.object({ id: z.string(), type: z.string(), ledger_id: z.string(), entity_id: z.string(), data: z.record(z.string(), z.unknown()), created_at: Iso });
export const EventsQuery = PageQuery.extend({ type: z.string().max(40).optional() });
```

- [ ] **Step 3: Routes**

Shared helpers at the top of `src/routes/ledgers.ts`, exported for the other route files:
```ts
import { z } from "zod";
import type { PoolClient } from "pg";
import { defineRoute, parsePage } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { newId } from "../domain/ids.js";
import { ApiError, notFound } from "../domain/errors.js";
import * as L from "../db/ledger.js";
import { IdParam, PageQuery, PagedOf } from "../schemas/common.js";
import { LedgerCreate, LedgerOut } from "../schemas/ledgers.js";

export const ledgerOut = (l: L.LedgerRow) => ({
  id: l.id, name: l.name, next_seq: l.next_seq, head_hash: l.head_hash.toString("hex"),
  last_activity_at: l.last_activity_at.toISOString(), created_at: l.created_at.toISOString(),
});

/** Every ledger scoped route starts here. A ledger owned by another key is a 404, never a 403, so ids do not leak. */
export async function ownLedger(c: PoolClient, keyId: string, ledgerId: string): Promise<L.LedgerRow> {
  const l = await L.getLedger(c, keyId, ledgerId);
  if (!l) throw notFound("ledger");
  return l;
}

export const ledgerRoutes = [
  defineRoute({
    method: "post", path: "/v1/ledgers", summary: "Create a ledger", tag: "Ledgers", auth: "bearer", scope: "ledger:write", idempotent: true, status: 201,
    body: LedgerCreate, response: LedgerOut,
    handler: async ({ deps, key, body }) => withTx(deps.pool, async (c) => {
      if (key!.mode === "test" && (await L.countLedgers(c, key!.id)) >= 10) throw new ApiError(409, "sandbox_limit_reached", "ledgers per key: 10");
      return ledgerOut(await L.createLedger(c, { id: newId("ldg"), keyId: key!.id, name: body.name }));
    }),
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers", summary: "List ledgers", tag: "Ledgers", auth: "bearer", scope: "ledger:read",
    query: PageQuery, response: PagedOf(LedgerOut),
    handler: async ({ deps, key, query }) => withTx(deps.pool, async (c) => {
      const page = await L.listLedgers(c, key!.id, parsePage(query));
      return { data: page.data.map(ledgerOut), next_cursor: page.next_cursor };
    }),
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}", summary: "Read a ledger", tag: "Ledgers", auth: "bearer", scope: "ledger:read",
    params: z.object({ id: IdParam("ldg") }), response: LedgerOut,
    handler: async ({ deps, key, params }) => withTx(deps.pool, async (c) => ledgerOut(await ownLedger(c, key!.id, params.id))),
  }),
];
```

`src/routes/accounts.ts`:
```ts
import { z } from "zod";
import { defineRoute, parsePage } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { newId } from "../domain/ids.js";
import { ApiError, notFound, validation } from "../domain/errors.js";
import * as L from "../db/ledger.js";
import { IdParam, PageQuery, PagedOf } from "../schemas/common.js";
import { AccountCreate, AccountOut } from "../schemas/accounts.js";
import { ownLedger } from "./ledgers.js";

export const accountOut = (a: L.AccountRow) => ({
  id: a.id, ledger_id: a.ledger_id, asset: a.asset, name: a.name, kind: a.kind,
  balance: a.balance, held: a.held, available: (BigInt(a.balance) - BigInt(a.held)).toString(),
  metadata: a.metadata, created_at: a.created_at.toISOString(),
});

const Params = z.object({ id: IdParam("ldg") });
const AccountParams = Params.extend({ accountId: IdParam("acct") });

export const accountRoutes = [
  defineRoute({
    method: "post", path: "/v1/ledgers/{id}/accounts", summary: "Create an account", tag: "Accounts", auth: "bearer", scope: "ledger:write", idempotent: true, status: 201,
    params: Params, body: AccountCreate, response: AccountOut,
    handler: async ({ deps, key, params, body }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      const asset = await c.query("select 1 from assets where code = $1", [body.asset]);
      if (asset.rowCount === 0) throw validation("unknown asset", [{ path: "asset", message: `no asset ${body.asset}` }]);
      if (key!.mode === "test" && (await L.countAccounts(c, ledger.id)) >= 50) throw new ApiError(409, "sandbox_limit_reached", "accounts per ledger: 50");
      return accountOut(await L.createAccount(c, { id: newId("acct"), ledgerId: ledger.id, asset: body.asset, name: body.name, metadata: body.metadata }));
    }),
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/accounts", summary: "List accounts", tag: "Accounts", auth: "bearer", scope: "ledger:read",
    params: Params, query: PageQuery, response: PagedOf(AccountOut),
    handler: async ({ deps, key, params, query }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      await L.expireHolds(c, ledger.id, null);
      const page = await L.listAccounts(c, ledger.id, parsePage(query));
      return { data: page.data.map(accountOut), next_cursor: page.next_cursor };
    }),
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/accounts/{accountId}", summary: "Read an account", tag: "Accounts", auth: "bearer", scope: "ledger:read",
    params: AccountParams, response: AccountOut,
    handler: async ({ deps, key, params }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      await L.expireHolds(c, ledger.id, params.accountId);
      const a = await L.getAccount(c, ledger.id, params.accountId);
      if (!a) throw notFound("account");
      return accountOut(a);
    }),
  }),
];
```

`src/routes/transfers.ts`:
```ts
import { z } from "zod";
import { defineRoute, parsePage } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { newId } from "../domain/ids.js";
import { notFound } from "../domain/errors.js";
import * as L from "../db/ledger.js";
import { IdParam, PageQuery, PagedOf } from "../schemas/common.js";
import { TransferCreate, TransferOut } from "../schemas/transfers.js";
import { ownLedger } from "./ledgers.js";
import { afterCommit } from "../platform/fanout.js";

export const transferOut = (t: L.TransferRow) => ({
  id: t.id, ledger_id: t.ledger_id, seq: t.seq, memo: t.memo, metadata: t.metadata, created_at: t.created_at.toISOString(),
  legs: t.legs.map((l) => ({ position: l.position, from: l.from_account, from_hold: l.from_hold, to: l.to_account, asset: l.asset, amount: l.amount })),
});

const Params = z.object({ id: IdParam("ldg") });

export const transferRoutes = [
  defineRoute({
    method: "post", path: "/v1/ledgers/{id}/transfers", summary: "Post a transfer of one or more legs, atomically", tag: "Transfers", auth: "bearer", scope: "ledger:write", idempotent: true, status: 201,
    params: Params, body: TransferCreate, response: TransferOut,
    handler: async ({ deps, key, params, body }) => {
      const { out, eventIds } = await withTx(deps.pool, async (c) => {
        const ledger = await ownLedger(c, key!.id, params.id);
        const r = await L.postTransfer(c, { ledgerId: ledger.id, transferId: newId("tr"), legs: body.legs, memo: body.memo, metadata: body.metadata });
        const t = await L.getTransfer(c, ledger.id, r.id);
        return { out: transferOut(t!), eventIds: r.event_ids };
      });
      await afterCommit(deps, eventIds);
      return out;
    },
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/transfers", summary: "List transfers, newest first", tag: "Transfers", auth: "bearer", scope: "ledger:read",
    params: Params, query: PageQuery.extend({ account: IdParam("acct").optional() }), response: PagedOf(TransferOut),
    handler: async ({ deps, key, params, query }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      const page = await L.listTransfers(c, ledger.id, parsePage(query), query.account ?? null);
      return { data: page.data.map(transferOut), next_cursor: page.next_cursor };
    }),
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/transfers/{transferId}", summary: "Read a transfer", tag: "Transfers", auth: "bearer", scope: "ledger:read",
    params: Params.extend({ transferId: IdParam("tr") }), response: TransferOut,
    handler: async ({ deps, key, params }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      const t = await L.getTransfer(c, ledger.id, params.transferId);
      if (!t) throw notFound("transfer");
      return transferOut(t);
    }),
  }),
];
```

`src/routes/holds.ts`:
```ts
import { z } from "zod";
import { defineRoute, parsePage } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { newId } from "../domain/ids.js";
import { notFound } from "../domain/errors.js";
import * as L from "../db/ledger.js";
import { IdParam, PageQuery, PagedOf } from "../schemas/common.js";
import { HoldCreate, HoldCapture, HoldOut, HoldCaptureOut, HoldReleaseOut } from "../schemas/holds.js";
import { ownLedger } from "./ledgers.js";
import { transferOut } from "./transfers.js";
import { afterCommit } from "../platform/fanout.js";

export const holdOut = (h: L.HoldRow) => ({
  id: h.id, ledger_id: h.ledger_id, account_id: h.account_id, asset: h.asset, amount: h.amount, remaining: h.remaining,
  status: h.status, expires_at: h.expires_at.toISOString(), memo: h.memo, metadata: h.metadata,
  created_at: h.created_at.toISOString(), closed_at: h.closed_at?.toISOString() ?? null,
});

const Params = z.object({ id: IdParam("ldg") });
const HoldParams = Params.extend({ holdId: IdParam("hold") });

export const holdRoutes = [
  defineRoute({
    method: "post", path: "/v1/ledgers/{id}/holds", summary: "Hold funds on an account", tag: "Holds", auth: "bearer", scope: "ledger:write", idempotent: true, status: 201,
    params: Params, body: HoldCreate, response: HoldOut,
    handler: async ({ deps, key, params, body }) => {
      const { out, eventIds } = await withTx(deps.pool, async (c) => {
        const ledger = await ownLedger(c, key!.id, params.id);
        const r = await L.createHold(c, { ledgerId: ledger.id, holdId: newId("hold"), accountId: body.account, amount: body.amount,
          expiresAt: new Date(Date.now() + body.expires_in_seconds * 1000), memo: body.memo, metadata: body.metadata });
        return { out: holdOut((await L.getHold(c, ledger.id, r.id))!), eventIds: r.event_ids };
      });
      await afterCommit(deps, eventIds);
      return out;
    },
  }),
  defineRoute({
    method: "post", path: "/v1/ledgers/{id}/holds/{holdId}/capture", summary: "Capture some or all of a hold into a transfer", tag: "Holds", auth: "bearer", scope: "ledger:write", idempotent: true,
    params: HoldParams, body: HoldCapture, response: HoldCaptureOut,
    handler: async ({ deps, key, params, body }) => {
      const { out, eventIds } = await withTx(deps.pool, async (c) => {
        const ledger = await ownLedger(c, key!.id, params.id);
        const hold = await L.getHold(c, ledger.id, params.holdId);
        if (!hold) throw notFound("hold");
        const amount = body.amount ?? hold.remaining;
        const r = await L.postTransfer(c, { ledgerId: ledger.id, transferId: newId("tr"), legs: [{ from_hold: hold.id, to: body.to, asset: hold.asset, amount }], memo: `capture ${hold.id}`, metadata: {} });
        const eventIds = [...r.event_ids];
        const after = (await L.getHold(c, ledger.id, hold.id))!;
        if (body.release_remainder && after.status === "open") eventIds.push(...(await L.releaseHold(c, ledger.id, hold.id, "hold.released")).event_ids);
        return { out: { hold: holdOut((await L.getHold(c, ledger.id, hold.id))!), transfer: transferOut((await L.getTransfer(c, ledger.id, r.id))!) }, eventIds };
      });
      await afterCommit(deps, eventIds);
      return out;
    },
  }),
  defineRoute({
    method: "post", path: "/v1/ledgers/{id}/holds/{holdId}/release", summary: "Release what remains of a hold", tag: "Holds", auth: "bearer", scope: "ledger:write", idempotent: true,
    params: HoldParams, body: z.object({}).optional(), response: HoldReleaseOut,
    handler: async ({ deps, key, params }) => {
      const { out, eventIds } = await withTx(deps.pool, async (c) => {
        const ledger = await ownLedger(c, key!.id, params.id);
        if (!(await L.getHold(c, ledger.id, params.holdId))) throw notFound("hold");
        const r = await L.releaseHold(c, ledger.id, params.holdId, "hold.released");
        return { out: { hold: holdOut((await L.getHold(c, ledger.id, params.holdId))!), released: r.released }, eventIds: r.event_ids };
      });
      await afterCommit(deps, eventIds);
      return out;
    },
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/holds", summary: "List holds", tag: "Holds", auth: "bearer", scope: "ledger:read",
    params: Params, query: PageQuery.extend({ account: IdParam("acct").optional(), status: z.enum(["open", "captured", "released", "expired"]).optional() }), response: PagedOf(HoldOut),
    handler: async ({ deps, key, params, query }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      await L.expireHolds(c, ledger.id, query.account ?? null);
      const page = await L.listHolds(c, ledger.id, parsePage(query), { accountId: query.account ?? null, status: query.status ?? null });
      return { data: page.data.map(holdOut), next_cursor: page.next_cursor };
    }),
  }),
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/holds/{holdId}", summary: "Read a hold", tag: "Holds", auth: "bearer", scope: "ledger:read",
    params: HoldParams, response: HoldOut,
    handler: async ({ deps, key, params }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      const before = await L.getHold(c, ledger.id, params.holdId);
      if (!before) throw notFound("hold");
      await L.expireHolds(c, ledger.id, before.account_id);
      return holdOut((await L.getHold(c, ledger.id, params.holdId))!);
    }),
  }),
];
```

`src/routes/journal.ts`:
```ts
import { z } from "zod";
import { defineRoute } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import * as L from "../db/ledger.js";
import { IdParam } from "../schemas/common.js";
import { JournalEntryOut, JournalQuery } from "../schemas/journal.js";
import { ownLedger } from "./ledgers.js";

export const journalRoutes = [
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/journal", summary: "The journal, oldest first", tag: "Journal", auth: "bearer", scope: "ledger:read",
    params: z.object({ id: IdParam("ldg") }), query: JournalQuery, response: z.object({ data: z.array(JournalEntryOut), next_since: z.string().nullable() }),
    handler: async ({ deps, key, params, query }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      const rows = await L.listJournal(c, ledger.id, BigInt(query.since), query.limit + 1);
      const data = rows.slice(0, query.limit).map((r) => ({
        seq: r.seq, kind: r.kind, entity_id: r.entity_id, payload: r.payload,
        prev_hash: r.prev_hash.toString("hex"), hash: r.hash.toString("hex"), created_at: r.created_at.toISOString(),
      }));
      return { data, next_since: rows.length > query.limit ? data[data.length - 1]!.seq : null };
    }),
  }),
];
```

`src/db/events.ts` and `src/routes/events.ts`:
```ts
import type { PoolClient } from "pg";
import type { Page, Paged } from "./ledger.js";
import { encodeCursor } from "../domain/cursor.js";

export interface EventRow { id: string; key_id: string; ledger_id: string; type: string; entity_id: string; payload: Record<string, unknown>; created_at: Date }

export async function listEvents(c: PoolClient, keyId: string, page: Page, type: string | null): Promise<Paged<EventRow>> {
  const { rows } = await c.query<EventRow>(
    `select * from events where key_id = $1 and ($5::text is null or type = $5)
       and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::text))
     order by created_at desc, id desc limit $4`,
    [keyId, page.cursor?.t ?? null, page.cursor?.id ?? "", page.limit + 1, type]);
  const data = rows.slice(0, page.limit);
  const last = rows.length > page.limit ? data[data.length - 1] : undefined;
  return { data, next_cursor: last ? encodeCursor({ t: last.created_at.toISOString(), id: last.id }) : null };
}

export async function getEvent(c: PoolClient, keyId: string, id: string): Promise<EventRow | null> {
  const { rows } = await c.query<EventRow>("select * from events where id = $1 and key_id = $2", [id, keyId]);
  return rows[0] ?? null;
}

export async function getEventsByIds(c: PoolClient, ids: string[]): Promise<EventRow[]> {
  const { rows } = await c.query<EventRow>("select * from events where id = any($1)", [ids]);
  return rows;
}
```
```ts
import { z } from "zod";
import { defineRoute, parsePage } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { notFound } from "../domain/errors.js";
import { listEvents, getEvent, type EventRow } from "../db/events.js";
import { IdParam, PagedOf } from "../schemas/common.js";
import { EventOut, EventsQuery } from "../schemas/events.js";

export const eventOut = (e: EventRow) => ({ id: e.id, type: e.type, ledger_id: e.ledger_id, entity_id: e.entity_id, data: e.payload, created_at: e.created_at.toISOString() });

export const eventRoutes = [
  defineRoute({
    method: "get", path: "/v1/events", summary: "Everything that happened, newest first", tag: "Events", auth: "bearer", scope: "ledger:read",
    query: EventsQuery, response: PagedOf(EventOut),
    handler: async ({ deps, key, query }) => withTx(deps.pool, async (c) => {
      const page = await listEvents(c, key!.id, parsePage(query), query.type ?? null);
      return { data: page.data.map(eventOut), next_cursor: page.next_cursor };
    }),
  }),
  defineRoute({
    method: "get", path: "/v1/events/{id}", summary: "Read an event", tag: "Events", auth: "bearer", scope: "ledger:read",
    params: z.object({ id: IdParam("evt") }), response: EventOut,
    handler: async ({ deps, key, params }) => withTx(deps.pool, async (c) => {
      const e = await getEvent(c, key!.id, params.id);
      if (!e) throw notFound("event");
      return eventOut(e);
    }),
  }),
];
```

`src/platform/fanout.ts` (this task):
```ts
import type { AppDeps } from "../deps.js";

/** Called after a write commits with the ids of the events it produced. Task 11 makes this deliver webhooks. */
export async function afterCommit(deps: AppDeps, eventIds: string[]): Promise<void> {
  if (eventIds.length > 0) deps.logger.debug({ event_ids: eventIds }, "events committed");
}
```

Add all route arrays to `src/routes/index.ts` in this order: health, assets, keys, ledgers, accounts, transfers, holds, journal, events.

- [ ] **Step 4: Run everything, commit**

Run: `npm run build && npx vitest run`
Expected: green, including all three idempotency cases from Task 8. If `validation_failed` on `legs.0.amount` reports path `legs.0.from` instead, the refine on `LegIn` runs before the amount check; swap to `z.object(...).superRefine` ordering or assert on any error whose path starts with `legs.0`.

```bash
git add -A
git commit -m "Ledgers, accounts, transfers, holds, the journal and events over HTTP"
```

---

### Task 10: Verify, the proof endpoint

**Files:**
- Create: `src/domain/verify.ts` (pure replay logic), `src/routes/verify.ts`, `src/platform/cache.ts` (add `UpstashCache`)
- Modify: `src/routes/index.ts`, `src/deps.ts`
- Test: `tests/unit/verify.test.ts`, `tests/integration/verify.test.ts`

**Interfaces:**
- Produces: `class Replay { apply(entry: JournalEntryLike): void; balances: Map<string, { balance: bigint; held: bigint; asset: string }>; sums(): Map<string, bigint> }` and `verifyChain(entries: AsyncIterable<JournalRow>): Promise<VerifyReport>` in `src/domain/verify.ts`.
- `VerifyReport = { ok: boolean; entries_checked: number; first_bad_seq: string | null; chain_ok: boolean; replay_matches: boolean; sequence_ok: boolean; assets: Array<{ asset: string; sum: string }> }`.
- Route: `GET /v1/ledgers/{id}/verify`, limit bucket `verify`, result cached 60 seconds under `verify:{ledgerId}:{next_seq}`.
- Produces: `class UpstashCache implements Cache`.

- [ ] **Step 1: Failing unit test for the replay**

`tests/unit/verify.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Replay } from "../../src/domain/verify.js";

const entry = (seq: number, kind: string, payload: Record<string, unknown>) => ({ seq: String(seq), kind, payload: { ...payload, seq, kind } });

describe("Replay", () => {
  it("reproduces balances and held from transfer and hold entries", () => {
    const r = new Replay();
    r.apply(entry(1, "transfer.posted", { transfer: { legs: [{ from: "w", to: "a", asset: "GHS", amount: "1000", from_hold: null }] } }));
    r.apply(entry(2, "hold.created", { hold: { id: "h1", account: "a", asset: "GHS", amount: "400" } }));
    r.apply(entry(3, "transfer.posted", { transfer: { legs: [{ from: "a", to: "b", asset: "GHS", amount: "150", from_hold: "h1" }] } }));
    r.apply(entry(4, "hold.released", { hold: { id: "h1", account: "a", asset: "GHS", amount: "250" } }));
    expect(r.balances.get("a")).toEqual({ balance: 850n, held: 0n, asset: "GHS" });
    expect(r.balances.get("b")).toEqual({ balance: 150n, held: 0n, asset: "GHS" });
    expect(r.balances.get("w")).toEqual({ balance: -1000n, held: 0n, asset: "GHS" });
    expect(r.sums().get("GHS")).toBe(0n);
  });
  it("ignores informational entries", () => {
    const r = new Replay();
    r.apply(entry(1, "hold.captured", { hold: { id: "h", account: "a", asset: "GHS", amount: "5" } }));
    expect(r.balances.size).toBe(0);
  });
});
```

- [ ] **Step 2: Implement the domain and the route**

`src/domain/verify.ts`:
```ts
import { canonicalJson, hashEntry, GENESIS_HASH, type JsonValue } from "./canonical.js";

export interface JournalEntryLike { seq: string; kind: string; payload: Record<string, unknown> }
export interface JournalRowLike extends JournalEntryLike { prev_hash: Buffer; hash: Buffer }
export interface VerifyReport {
  ok: boolean; entries_checked: number; first_bad_seq: string | null;
  chain_ok: boolean; sequence_ok: boolean; replay_matches: boolean;
  assets: Array<{ asset: string; sum: string }>;
}

interface Leg { from: string; to: string; asset: string; amount: string; from_hold: string | null }

export class Replay {
  readonly balances = new Map<string, { balance: bigint; held: bigint; asset: string }>();
  private acc(id: string, asset: string) {
    let a = this.balances.get(id);
    if (!a) { a = { balance: 0n, held: 0n, asset }; this.balances.set(id, a); }
    return a;
  }
  apply(e: JournalEntryLike): void {
    if (e.kind === "transfer.posted") {
      const legs = ((e.payload.transfer as { legs: Leg[] }).legs);
      for (const l of legs) {
        const amount = BigInt(l.amount);
        const from = this.acc(l.from, l.asset);
        from.balance -= amount;
        if (l.from_hold) from.held -= amount;
        this.acc(l.to, l.asset).balance += amount;
      }
    } else if (e.kind === "hold.created") {
      const h = e.payload.hold as { account: string; asset: string; amount: string };
      this.acc(h.account, h.asset).held += BigInt(h.amount);
    } else if (e.kind === "hold.released" || e.kind === "hold.expired") {
      const h = e.payload.hold as { account: string; asset: string; amount: string };
      this.acc(h.account, h.asset).held -= BigInt(h.amount);
    }
  }
  sums(): Map<string, bigint> {
    const out = new Map<string, bigint>();
    for (const a of this.balances.values()) out.set(a.asset, (out.get(a.asset) ?? 0n) + a.balance);
    return out;
  }
}

/** Walks entries in order, recomputing every hash and replaying every effect. Stops recording the first bad seq but keeps counting. */
export async function verifyChain(entries: AsyncIterable<JournalRowLike>, stored: Map<string, { balance: bigint; held: bigint }>): Promise<VerifyReport> {
  const replay = new Replay();
  let prev = GENESIS_HASH;
  let expected = 1n;
  let checked = 0;
  let firstBad: string | null = null;
  let chainOk = true;
  let sequenceOk = true;
  for await (const row of entries) {
    checked++;
    if (BigInt(row.seq) !== expected) { sequenceOk = false; firstBad ??= row.seq; }
    const recomputed = hashEntry(prev, canonicalJson(row.payload as JsonValue));
    if (!row.prev_hash.equals(prev) || !recomputed.equals(row.hash)) { chainOk = false; firstBad ??= row.seq; }
    replay.apply(row);
    prev = row.hash;
    expected = BigInt(row.seq) + 1n;
  }
  let replayMatches = true;
  for (const [id, s] of stored) {
    const r = replay.balances.get(id) ?? { balance: 0n, held: 0n };
    if (r.balance !== s.balance || r.held !== s.held) replayMatches = false;
  }
  const assets = [...replay.sums()].map(([asset, sum]) => ({ asset, sum: sum.toString() })).sort((a, b) => a.asset.localeCompare(b.asset));
  const zero = assets.every((a) => a.sum === "0");
  return { ok: chainOk && sequenceOk && replayMatches && zero, entries_checked: checked, first_bad_seq: firstBad, chain_ok: chainOk, sequence_ok: sequenceOk, replay_matches: replayMatches, assets };
}
```

`src/routes/verify.ts`:
```ts
import { z } from "zod";
import { defineRoute } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import * as L from "../db/ledger.js";
import { IdParam } from "../schemas/common.js";
import { ownLedger } from "./ledgers.js";
import { verifyChain } from "../domain/verify.js";

const Report = z.object({
  ok: z.boolean(), entries_checked: z.number().int(), first_bad_seq: z.string().nullable(),
  chain_ok: z.boolean(), sequence_ok: z.boolean(), replay_matches: z.boolean(),
  assets: z.array(z.object({ asset: z.string(), sum: z.string() })), cached: z.boolean(),
});

export const verifyRoutes = [
  defineRoute({
    method: "get", path: "/v1/ledgers/{id}/verify", summary: "Recompute the whole chain and prove every asset sums to zero", tag: "Journal",
    auth: "bearer", scope: "ledger:read", limit: "verify",
    params: z.object({ id: IdParam("ldg") }), response: Report,
    handler: async ({ deps, key, params }) => withTx(deps.pool, async (c) => {
      const ledger = await ownLedger(c, key!.id, params.id);
      const cacheKey = `verify:${ledger.id}:${ledger.next_seq}`;
      const hit = await deps.cache.get(cacheKey);
      if (hit) return { ...(JSON.parse(hit) as z.infer<typeof Report>), cached: true };
      const { rows } = await c.query<{ id: string; balance: string; held: string }>("select id, balance::text, held::text from accounts where ledger_id = $1", [ledger.id]);
      const stored = new Map(rows.map((r) => [r.id, { balance: BigInt(r.balance), held: BigInt(r.held) }]));
      async function* entries() {
        let since = 0n;
        for (;;) {
          const batch = await L.listJournal(c, ledger.id, since, 500);
          if (batch.length === 0) return;
          for (const row of batch) yield row;
          since = BigInt(batch[batch.length - 1]!.seq);
        }
      }
      const report = await verifyChain(entries(), stored);
      await deps.cache.set(cacheKey, JSON.stringify(report), 60);
      return { ...report, cached: false };
    }),
  }),
];
```

Add `UpstashCache` to `src/platform/cache.ts`:
```ts
import { Redis } from "@upstash/redis";
export class UpstashCache implements Cache {
  private readonly redis: Redis;
  constructor(url: string, token: string) { this.redis = new Redis({ url, token }); }
  async get(key: string): Promise<string | null> { return (await this.redis.get<string>(key)) ?? null; }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> { await this.redis.set(key, value, { ex: ttlSeconds }); }
}
```
Wire it in `src/deps.ts` beside the limiter choice.

- [ ] **Step 3: Failing integration test, then green**

`tests/integration/verify.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";

describe("verify", () => {
  it("passes on an honest ledger, then fails naming the tampered sequence", async () => {
    const { app, deps } = await makeTestApp();
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "v" })).body;
    const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "USDT", name: "a" })).body;
    const b = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "USDT", name: "b" })).body;
    await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:USDT", to: a.id, asset: "USDT", amount: "1000000" }] });
    for (let i = 0; i < 5; i++) await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: a.id, to: b.id, asset: "USDT", amount: "1000" }] });
    const hold = (await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: a.id, amount: "500" })).body;
    await request(app).post(`/v1/ledgers/${l.id}/holds/${hold.id}/capture`).set(h).send({ to: b.id, amount: "200", release_remainder: true });
    const good = await request(app).get(`/v1/ledgers/${l.id}/verify`).set(h);
    expect(good.status).toBe(200);
    expect(good.body).toMatchObject({ ok: true, chain_ok: true, sequence_ok: true, replay_matches: true, cached: false, entries_checked: 9 });
    expect(good.body.assets).toEqual([{ asset: "USDT", sum: "0" }]);
    expect((await request(app).get(`/v1/ledgers/${l.id}/verify`).set(h)).body.cached).toBe(true);
    // Tamper with history: edit an amount inside entry 3 without touching its hash.
    await deps.pool.query("update journal set payload = jsonb_set(payload, '{transfer,legs,0,amount}', '\"999\"') where ledger_id = $1 and seq = 3", [l.id]);
    await deps.pool.query("update ledgers set next_seq = next_seq where id = $1", [l.id]);
    // Bust the cache by writing once more.
    await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: a.id, to: b.id, asset: "USDT", amount: "1" }] });
    const bad = await request(app).get(`/v1/ledgers/${l.id}/verify`).set(h);
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.chain_ok).toBe(false);
    expect(bad.body.first_bad_seq).toBe("3");
    expect(bad.body.replay_matches).toBe(false);
  });
  it("is limited to ten a minute", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "v" })).body;
    for (let i = 0; i < 10; i++) expect((await request(app).get(`/v1/ledgers/${l.id}/verify`).set(h)).status).toBe(200);
    expect((await request(app).get(`/v1/ledgers/${l.id}/verify`).set(h)).status).toBe(429);
  });
});
```

Run: `npm run build && npx vitest run`
Expected: green. `entries_checked` is 9: one funding transfer, five transfers, one hold created, one capture transfer, one hold released (the capture drew 200 of 500, so the hold stayed open and `release_remainder` released 300; no `hold.captured` entry because the hold never reached zero through the transfer).

```bash
git add -A
git commit -m "Verify: recompute every hash, replay every entry, and prove each asset sums to zero"
```

---

### Task 11: Webhooks, signed and retried through QStash

**Files:**
- Create: `db/migrations/0008_webhooks.sql`, `src/db/webhooks.ts`, `src/platform/webhook-sign.ts`, `src/platform/scheduler.ts` (add `QStashScheduler`), `src/platform/deliver.ts`, `src/schemas/webhooks.ts`, `src/routes/webhooks.ts`, `src/routes/internal.ts` (the deliver callback; the sweep is Task 14)
- Modify: `src/platform/fanout.ts`, `src/routes/index.ts`, `src/deps.ts`
- Test: `tests/unit/webhook-sign.test.ts`, `tests/integration/webhooks.test.ts`

**Interfaces:**
- Produces: `signPayload(secret: string, timestamp: number, body: string): string` (hex) and `verifySignature(secret, header, body, now, toleranceSeconds = 300): boolean` in `src/platform/webhook-sign.ts`. Header format `t=<unix seconds>,v1=<hex>`.
- Produces: `deliverOnce(deps, deliveryId): Promise<void>` in `src/platform/deliver.ts`, which performs one attempt, records it, and schedules the next or marks dead.
- Produces: `RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 3600, 10800, 21600, 43200]`.
- Produces: `class QStashScheduler implements DeliveryScheduler` publishing to `${PUBLIC_BASE_URL}/internal/webhooks/deliver` with `Upstash-Delay`.
- `afterCommit` now creates deliveries and schedules them with delay 0.
- Routes: `POST /v1/webhooks`, `GET /v1/webhooks`, `GET /v1/webhooks/{id}`, `PATCH /v1/webhooks/{id}`, `DELETE /v1/webhooks/{id}`, `GET /v1/webhooks/{id}/deliveries`, `POST /v1/webhooks/{id}/deliveries/{deliveryId}/retry`, `POST /internal/webhooks/deliver`.
- Delivery body: `{ id, type, ledger_id, entity_id, data, created_at }`, the same shape as `GET /v1/events/{id}`.

- [ ] **Step 1: Migration**

`db/migrations/0008_webhooks.sql`:
```sql
create table webhook_endpoints (
  id text primary key,
  key_id text not null references api_keys(id) on delete cascade,
  url text not null,
  secret text not null,
  events text[] not null,
  status text not null check (status in ('active', 'disabled')),
  consecutive_failures int not null default 0,
  created_at timestamptz not null default now()
);
create index webhook_endpoints_key_idx on webhook_endpoints (key_id, created_at desc, id);

create table webhook_deliveries (
  id text primary key,
  endpoint_id text not null references webhook_endpoints(id) on delete cascade,
  event_id text not null references events(id) on delete cascade,
  attempt int not null default 0,
  status text not null check (status in ('pending', 'succeeded', 'failed', 'dead')),
  response_status int,
  response_excerpt text,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index webhook_deliveries_endpoint_idx on webhook_deliveries (endpoint_id, created_at desc, id);
create index webhook_deliveries_pending_idx on webhook_deliveries (next_attempt_at) where status = 'pending';
```

- [ ] **Step 2: Failing tests**

`tests/unit/webhook-sign.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { signPayload, verifySignature } from "../../src/platform/webhook-sign.js";

describe("webhook signatures", () => {
  it("signs and verifies inside the tolerance", () => {
    const body = '{"id":"evt_1"}';
    const t = 1_800_000_000;
    const header = `t=${t},v1=${signPayload("whsec", t, body)}`;
    expect(verifySignature("whsec", header, body, t + 100)).toBe(true);
    expect(verifySignature("whsec", header, body + " ", t + 100)).toBe(false);
    expect(verifySignature("other", header, body, t + 100)).toBe(false);
    expect(verifySignature("whsec", header, body, t + 301)).toBe(false);
    expect(verifySignature("whsec", "garbage", body, t)).toBe(false);
  });
});
```

`tests/integration/webhooks.test.ts` (a local receiver on a random port stands in for the customer's server):
```ts
import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import { verifySignature } from "../../src/platform/webhook-sign.js";
import { deliverOnce } from "../../src/platform/deliver.js";
import { MemoryScheduler } from "../../src/platform/scheduler.js";

interface Received { body: string; headers: Record<string, string | string[] | undefined> }

function receiver(status: () => number): Promise<{ url: string; got: Received[]; close: () => void }> {
  const got: Received[] = [];
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { got.push({ body, headers: req.headers }); res.statusCode = status(); res.end("ok"); });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/hook`, got, close: () => server.close() });
    });
  });
}

describe("webhooks", () => {
  it("registers an endpoint, delivers a signed event, and the verifier accepts it", async () => {
    const { app, deps } = await makeTestApp();
    // Deliver at once when scheduled with zero delay, the way QStash would a moment later.
    const scheduler = new MemoryScheduler((id) => deliverOnce(deps, id));
    deps.scheduler = scheduler;
    const rx = await receiver(() => 200);
    try {
      const k = await mintKey(app);
      const h = bearer(k.secret);
      const ep = await request(app).post("/v1/webhooks").set(h).send({ url: rx.url.replace("http://", "https://"), events: ["transfer.posted"] });
      expect(ep.status).toBe(201);
      expect(ep.body.secret).toMatch(/^whsec_/);
      // Tests may point at http; production requires https. Flip the stored url back for the local receiver.
      await deps.pool.query("update webhook_endpoints set url = $2 where id = $1", [ep.body.id, rx.url]);
      const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "w" })).body;
      const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "a" })).body;
      await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:GHS", to: a.id, asset: "GHS", amount: "100" }] });
      expect(rx.got).toHaveLength(1);
      const sig = rx.got[0]!.headers["plutus-signature"] as string;
      expect(verifySignature(ep.body.secret, sig, rx.got[0]!.body, Math.trunc(Date.now() / 1000))).toBe(true);
      const body = JSON.parse(rx.got[0]!.body);
      expect(body.type).toBe("transfer.posted");
      expect(rx.got[0]!.headers["plutus-event-id"]).toBe(body.id);
      const dl = await request(app).get(`/v1/webhooks/${ep.body.id}/deliveries`).set(h);
      expect(dl.body.data[0]).toMatchObject({ status: "succeeded", attempt: 1, response_status: 200 });
      // A hold event is not subscribed, so nothing more arrives.
      await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: a.id, amount: "1" });
      expect(rx.got).toHaveLength(1);
    } finally { rx.close(); }
  });

  it("retries with the schedule, dies after eight, and can be retried by hand", async () => {
    const { app, deps } = await makeTestApp();
    const scheduler = new MemoryScheduler();
    deps.scheduler = scheduler;
    const rx = await receiver(() => 500);
    try {
      const k = await mintKey(app);
      const h = bearer(k.secret);
      const ep = (await request(app).post("/v1/webhooks").set(h).send({ url: "https://example.com/x", events: ["*"] })).body;
      await deps.pool.query("update webhook_endpoints set url = $2 where id = $1", [ep.id, rx.url]);
      const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "w" })).body;
      await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "a" });
      const a = (await request(app).get(`/v1/ledgers/${l.id}/accounts`).set(h)).body.data[0];
      await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:GHS", to: a.id, asset: "GHS", amount: "100" }] });
      expect(scheduler.scheduled).toEqual([{ deliveryId: expect.stringMatching(/^whd_/), delaySeconds: 0 }]);
      const id = scheduler.scheduled[0]!.deliveryId;
      const delays: number[] = [];
      for (let i = 0; i < 8; i++) {
        await deliverOnce(deps, id);
        const last = scheduler.scheduled[scheduler.scheduled.length - 1]!;
        if (last.deliveryId === id && scheduler.scheduled.length === i + 2) delays.push(last.delaySeconds);
      }
      expect(delays).toEqual([30, 120, 600, 1800, 3600, 10800, 21600, 43200].slice(0, 7));
      const dl = (await request(app).get(`/v1/webhooks/${ep.id}/deliveries`).set(h)).body.data[0];
      expect(dl).toMatchObject({ status: "dead", attempt: 8, response_status: 500 });
      expect(rx.got).toHaveLength(8);
      const retry = await request(app).post(`/v1/webhooks/${ep.id}/deliveries/${id}/retry`).set(h).send({});
      expect(retry.status).toBe(202);
      expect(scheduler.scheduled[scheduler.scheduled.length - 1]).toEqual({ deliveryId: id, delaySeconds: 0 });
    } finally { rx.close(); }
  });

  it("caps endpoints at five, requires https, and disables after fifty consecutive failures", async () => {
    const { app, deps } = await makeTestApp();
    const k = await mintKey(app);
    const h = bearer(k.secret);
    expect((await request(app).post("/v1/webhooks").set(h).send({ url: "http://example.com/x", events: ["*"] })).status).toBe(422);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await request(app).post("/v1/webhooks").set(h).send({ url: `https://example.com/${i}`, events: ["*"] })).body.id);
    expect((await request(app).post("/v1/webhooks").set(h).send({ url: "https://example.com/6", events: ["*"] })).body.code).toBe("sandbox_limit_reached");
    await deps.pool.query("update webhook_endpoints set consecutive_failures = 50, status = 'disabled' where id = $1", [ids[0]]);
    const me = await request(app).get("/v1/keys/me").set(h);
    expect(me.headers["plutus-warning"]).toContain(ids[0]);
    const patched = await request(app).patch(`/v1/webhooks/${ids[0]}`).set(h).send({ status: "active" });
    expect(patched.body).toMatchObject({ status: "active", consecutive_failures: 0 });
    expect((await request(app).delete(`/v1/webhooks/${ids[1]}`).set(h)).status).toBe(204);
  });
});
```

- [ ] **Step 3: Implement**

`src/platform/webhook-sign.ts`:
```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifySignature(secret: string, header: string, body: string, nowSeconds: number, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (nowSeconds - t > toleranceSeconds || t - nowSeconds > toleranceSeconds) return false;
  const expected = Buffer.from(signPayload(secret, t, body), "hex");
  const given = Buffer.from(v1, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```

`src/db/webhooks.ts`:
```ts
import type { PoolClient } from "pg";
import { encodeCursor } from "../domain/cursor.js";
import type { Page, Paged } from "./ledger.js";

export interface EndpointRow { id: string; key_id: string; url: string; secret: string; events: string[]; status: "active" | "disabled"; consecutive_failures: number; created_at: Date }
export interface DeliveryRow { id: string; endpoint_id: string; event_id: string; attempt: number; status: "pending" | "succeeded" | "failed" | "dead"; response_status: number | null; response_excerpt: string | null; next_attempt_at: Date | null; delivered_at: Date | null; created_at: Date; updated_at: Date }

export async function insertEndpoint(c: PoolClient, row: { id: string; keyId: string; url: string; secret: string; events: string[] }): Promise<EndpointRow> {
  const { rows } = await c.query<EndpointRow>("insert into webhook_endpoints (id, key_id, url, secret, events, status) values ($1, $2, $3, $4, $5, 'active') returning *",
    [row.id, row.keyId, row.url, row.secret, row.events]);
  return rows[0] as EndpointRow;
}
export async function countEndpoints(c: PoolClient, keyId: string): Promise<number> {
  const { rows } = await c.query<{ n: string }>("select count(*)::text as n from webhook_endpoints where key_id = $1", [keyId]);
  return Number(rows[0]?.n ?? "0");
}
export async function getEndpoint(c: PoolClient, keyId: string, id: string): Promise<EndpointRow | null> {
  const { rows } = await c.query<EndpointRow>("select * from webhook_endpoints where id = $1 and key_id = $2", [id, keyId]);
  return rows[0] ?? null;
}
export async function listEndpoints(c: PoolClient, keyId: string): Promise<EndpointRow[]> {
  const { rows } = await c.query<EndpointRow>("select * from webhook_endpoints where key_id = $1 order by created_at desc, id desc", [keyId]);
  return rows;
}
export async function updateEndpoint(c: PoolClient, keyId: string, id: string, patch: { url?: string; events?: string[]; status?: "active" | "disabled" }): Promise<EndpointRow | null> {
  const { rows } = await c.query<EndpointRow>(
    `update webhook_endpoints set url = coalesce($3, url), events = coalesce($4, events), status = coalesce($5, status),
       consecutive_failures = case when $5 = 'active' then 0 else consecutive_failures end
     where id = $1 and key_id = $2 returning *`, [id, keyId, patch.url ?? null, patch.events ?? null, patch.status ?? null]);
  return rows[0] ?? null;
}
export async function deleteEndpoint(c: PoolClient, keyId: string, id: string): Promise<boolean> {
  const r = await c.query("delete from webhook_endpoints where id = $1 and key_id = $2", [id, keyId]);
  return (r.rowCount ?? 0) > 0;
}
export async function disabledEndpoints(c: PoolClient, keyId: string): Promise<string[]> {
  const { rows } = await c.query<{ id: string }>("select id from webhook_endpoints where key_id = $1 and status = 'disabled'", [keyId]);
  return rows.map((r) => r.id);
}
export async function subscribedEndpoints(c: PoolClient, keyId: string, type: string): Promise<EndpointRow[]> {
  const { rows } = await c.query<EndpointRow>("select * from webhook_endpoints where key_id = $1 and status = 'active' and ($2 = any(events) or '*' = any(events))", [keyId, type]);
  return rows;
}
export async function insertDelivery(c: PoolClient, id: string, endpointId: string, eventId: string): Promise<DeliveryRow> {
  const { rows } = await c.query<DeliveryRow>("insert into webhook_deliveries (id, endpoint_id, event_id, status, next_attempt_at) values ($1, $2, $3, 'pending', now()) returning *", [id, endpointId, eventId]);
  return rows[0] as DeliveryRow;
}
export async function getDelivery(c: PoolClient, id: string): Promise<(DeliveryRow & { endpoint: EndpointRow }) | null> {
  const { rows } = await c.query<DeliveryRow & { endpoint: EndpointRow }>(
    "select d.*, to_jsonb(e.*) as endpoint from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id where d.id = $1", [id]);
  const row = rows[0];
  if (!row) return null;
  row.endpoint.created_at = new Date(row.endpoint.created_at);
  return row;
}
export async function recordAttempt(c: PoolClient, id: string, r: { attempt: number; status: DeliveryRow["status"]; responseStatus: number | null; excerpt: string | null; nextAttemptAt: Date | null }): Promise<void> {
  await c.query(
    `update webhook_deliveries set attempt = $2, status = $3, response_status = $4, response_excerpt = $5, next_attempt_at = $6,
       delivered_at = case when $3 = 'succeeded' then now() else delivered_at end, updated_at = now() where id = $1`,
    [id, r.attempt, r.status, r.responseStatus, r.excerpt, r.nextAttemptAt]);
}
export async function bumpFailures(c: PoolClient, endpointId: string, reset: boolean): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `update webhook_endpoints set consecutive_failures = case when $2 then 0 else consecutive_failures + 1 end,
       status = case when (not $2) and consecutive_failures + 1 >= 50 then 'disabled' else status end
     where id = $1 returning consecutive_failures as n`, [endpointId, reset]);
  return rows[0]?.n ?? 0;
}
export async function listDeliveries(c: PoolClient, endpointId: string, page: Page): Promise<Paged<DeliveryRow>> {
  const { rows } = await c.query<DeliveryRow>(
    `select * from webhook_deliveries where endpoint_id = $1
       and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::text))
     order by created_at desc, id desc limit $4`, [endpointId, page.cursor?.t ?? null, page.cursor?.id ?? "", page.limit + 1]);
  const data = rows.slice(0, page.limit);
  const last = rows.length > page.limit ? data[data.length - 1] : undefined;
  return { data, next_cursor: last ? encodeCursor({ t: last.created_at.toISOString(), id: last.id }) : null };
}
export async function stalePending(c: PoolClient, olderThanMinutes: number): Promise<string[]> {
  const { rows } = await c.query<{ id: string }>("select id from webhook_deliveries where status = 'pending' and next_attempt_at < now() - ($1::int * interval '1 minute') limit 200", [olderThanMinutes]);
  return rows.map((r) => r.id);
}
```

`src/platform/deliver.ts`:
```ts
import { withTx } from "../db/pool.js";
import { getDelivery, recordAttempt, bumpFailures } from "../db/webhooks.js";
import { getEventsByIds } from "../db/events.js";
import { signPayload } from "./webhook-sign.js";
import type { AppDeps } from "../deps.js";

export const RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 3600, 10800, 21600, 43200];
export const MAX_ATTEMPTS = 8;

/** One attempt. Records the outcome, then schedules the next attempt or marks the delivery dead. */
export async function deliverOnce(deps: AppDeps, deliveryId: string): Promise<void> {
  const d = await withTx(deps.pool, (c) => getDelivery(c, deliveryId));
  if (!d || d.status === "succeeded" || d.status === "dead") return;
  const [event] = await withTx(deps.pool, (c) => getEventsByIds(c, [d.event_id]));
  if (!event) return;
  const body = JSON.stringify({ id: event.id, type: event.type, ledger_id: event.ledger_id, entity_id: event.entity_id, data: event.payload, created_at: event.created_at.toISOString() });
  const t = Math.trunc(Date.now() / 1000);
  const attempt = d.attempt + 1;
  let status: number | null = null;
  let excerpt: string | null = null;
  if (d.endpoint.status === "disabled") {
    excerpt = "endpoint disabled";
  } else {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    try {
      const res = await fetch(d.endpoint.url, {
        method: "POST", signal: ac.signal, redirect: "manual",
        headers: { "content-type": "application/json", "user-agent": "plutus-webhooks/1", "plutus-event-id": event.id, "plutus-signature": `t=${t},v1=${signPayload(d.endpoint.secret, t, body)}` },
        body,
      });
      status = res.status;
      excerpt = (await res.text()).slice(0, 1024);
    } catch (err) {
      excerpt = `request failed: ${(err as Error).name}`;
    } finally {
      clearTimeout(timer);
    }
  }
  const ok = status !== null && status >= 200 && status < 300;
  const nextDelay = RETRY_DELAYS_SECONDS[attempt - 1];
  const dead = !ok && (attempt >= MAX_ATTEMPTS || nextDelay === undefined);
  await withTx(deps.pool, async (c) => {
    await recordAttempt(c, d.id, {
      attempt, status: ok ? "succeeded" : dead ? "dead" : "pending", responseStatus: status, excerpt,
      nextAttemptAt: ok || dead ? null : new Date(Date.now() + (nextDelay ?? 0) * 1000),
    });
    await bumpFailures(c, d.endpoint_id, ok);
  });
  if (!ok && !dead && nextDelay !== undefined) await deps.scheduler.schedule(d.id, nextDelay);
}
```

`src/platform/fanout.ts` (replace the body):
```ts
import { withTx } from "../db/pool.js";
import { getEventsByIds } from "../db/events.js";
import { subscribedEndpoints, insertDelivery } from "../db/webhooks.js";
import { newId } from "../domain/ids.js";
import type { AppDeps } from "../deps.js";

export async function afterCommit(deps: AppDeps, eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;
  const deliveries = await withTx(deps.pool, async (c) => {
    const out: string[] = [];
    for (const event of await getEventsByIds(c, eventIds)) {
      for (const ep of await subscribedEndpoints(c, event.key_id, event.type)) {
        out.push((await insertDelivery(c, newId("whd"), ep.id, event.id)).id);
      }
    }
    return out;
  });
  for (const id of deliveries) {
    try { await deps.scheduler.schedule(id, 0); }
    catch (err) { deps.logger.error({ delivery_id: id, err: (err as Error).message }, "schedule failed; the sweep will republish"); }
  }
}
```

`QStashScheduler` appended to `src/platform/scheduler.ts`:
```ts
import { Client } from "@upstash/qstash";
export class QStashScheduler implements DeliveryScheduler {
  private readonly client: Client;
  constructor(token: string, private readonly callbackUrl: string) { this.client = new Client({ token }); }
  async schedule(deliveryId: string, delaySeconds: number): Promise<void> {
    await this.client.publishJSON({ url: this.callbackUrl, body: { delivery_id: deliveryId }, delay: delaySeconds, retries: 0 });
  }
}
```

`src/routes/internal.ts` (deliver callback; the sweep joins it in Task 14):
```ts
import { z } from "zod";
import { Receiver } from "@upstash/qstash";
import { defineRoute } from "../platform/route.js";
import { ApiError } from "../domain/errors.js";
import { deliverOnce } from "../platform/deliver.js";

export const internalRoutes = [
  defineRoute({
    method: "post", path: "/internal/webhooks/deliver", summary: "QStash callback that makes one delivery attempt", tag: "Internal", auth: "none", limit: "none",
    body: z.object({ delivery_id: z.string().regex(/^whd_[0-9a-f]{32}$/) }), response: z.object({ ok: z.boolean() }),
    handler: async ({ deps, body, req }) => {
      const { QSTASH_CURRENT_SIGNING_KEY: cur, QSTASH_NEXT_SIGNING_KEY: nxt, CRON_SECRET } = deps.config;
      const internal = req.header("x-plutus-internal");
      if (cur && nxt) {
        const sig = req.header("upstash-signature") ?? "";
        const ok = await new Receiver({ currentSigningKey: cur, nextSigningKey: nxt }).verify({ signature: sig, body: JSON.stringify(req.body), url: `${deps.config.PUBLIC_BASE_URL}/internal/webhooks/deliver` }).catch(() => false);
        if (!ok) throw new ApiError(401, "invalid_signature", "QStash signature did not verify");
      } else if (!CRON_SECRET || internal !== CRON_SECRET) {
        throw new ApiError(401, "unauthorized", "internal route");
      }
      await deliverOnce(deps, body.delivery_id);
      return { ok: true };
    },
  }),
];
```

`src/schemas/webhooks.ts` and `src/routes/webhooks.ts`:
```ts
import { z } from "zod";
import { Iso } from "./common.js";
export const EVENT_TYPES = ["transfer.posted", "hold.created", "hold.captured", "hold.released", "hold.expired"] as const;
export const EndpointCreate = z.object({
  url: z.string().url().refine((u) => u.startsWith("https://"), "must be https"),
  events: z.array(z.enum([...EVENT_TYPES, "*"])).min(1).max(10),
});
export const EndpointPatch = z.object({ url: EndpointCreate.shape.url.optional(), events: EndpointCreate.shape.events.optional(), status: z.enum(["active", "disabled"]).optional() });
export const EndpointOut = z.object({ id: z.string(), url: z.string(), events: z.array(z.string()), status: z.enum(["active", "disabled"]), consecutive_failures: z.number().int(), created_at: Iso });
export const EndpointCreated = EndpointOut.extend({ secret: z.string() });
export const DeliveryOut = z.object({ id: z.string(), event_id: z.string(), attempt: z.number().int(), status: z.enum(["pending", "succeeded", "failed", "dead"]), response_status: z.number().int().nullable(), response_excerpt: z.string().nullable(), next_attempt_at: Iso.nullable(), delivered_at: Iso.nullable(), created_at: Iso });
```
```ts
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { defineRoute, parsePage } from "../platform/route.js";
import { withTx } from "../db/pool.js";
import { newId } from "../domain/ids.js";
import { ApiError, notFound } from "../domain/errors.js";
import * as W from "../db/webhooks.js";
import { IdParam, PageQuery, PagedOf } from "../schemas/common.js";
import { EndpointCreate, EndpointPatch, EndpointOut, EndpointCreated, DeliveryOut } from "../schemas/webhooks.js";

const endpointOut = (e: W.EndpointRow) => ({ id: e.id, url: e.url, events: e.events, status: e.status, consecutive_failures: e.consecutive_failures, created_at: e.created_at.toISOString() });
const deliveryOut = (d: W.DeliveryRow) => ({ id: d.id, event_id: d.event_id, attempt: d.attempt, status: d.status, response_status: d.response_status, response_excerpt: d.response_excerpt, next_attempt_at: d.next_attempt_at?.toISOString() ?? null, delivered_at: d.delivered_at?.toISOString() ?? null, created_at: d.created_at.toISOString() });
const Params = z.object({ id: IdParam("whe") });

export const webhookRoutes = [
  defineRoute({ method: "post", path: "/v1/webhooks", summary: "Register an endpoint. The secret is shown once", tag: "Webhooks", auth: "bearer", scope: "webhooks:manage", idempotent: true, status: 201,
    body: EndpointCreate, response: EndpointCreated,
    handler: async ({ deps, key, body }) => withTx(deps.pool, async (c) => {
      if (key!.mode === "test" && (await W.countEndpoints(c, key!.id)) >= 5) throw new ApiError(409, "sandbox_limit_reached", "webhook endpoints per key: 5");
      const secret = `whsec_${randomBytes(24).toString("base64url")}`;
      const row = await W.insertEndpoint(c, { id: newId("whe"), keyId: key!.id, url: body.url, secret, events: body.events });
      return { ...endpointOut(row), secret };
    }) }),
  defineRoute({ method: "get", path: "/v1/webhooks", summary: "List endpoints", tag: "Webhooks", auth: "bearer", scope: "webhooks:manage",
    response: z.object({ data: z.array(EndpointOut) }),
    handler: async ({ deps, key }) => withTx(deps.pool, async (c) => ({ data: (await W.listEndpoints(c, key!.id)).map(endpointOut) })) }),
  defineRoute({ method: "get", path: "/v1/webhooks/{id}", summary: "Read an endpoint", tag: "Webhooks", auth: "bearer", scope: "webhooks:manage",
    params: Params, response: EndpointOut,
    handler: async ({ deps, key, params }) => withTx(deps.pool, async (c) => { const e = await W.getEndpoint(c, key!.id, params.id); if (!e) throw notFound("webhook endpoint"); return endpointOut(e); }) }),
  defineRoute({ method: "patch", path: "/v1/webhooks/{id}", summary: "Change an endpoint or re enable it", tag: "Webhooks", auth: "bearer", scope: "webhooks:manage",
    params: Params, body: EndpointPatch, response: EndpointOut,
    handler: async ({ deps, key, params, body }) => withTx(deps.pool, async (c) => { const e = await W.updateEndpoint(c, key!.id, params.id, body); if (!e) throw notFound("webhook endpoint"); return endpointOut(e); }) }),
  defineRoute({ method: "delete", path: "/v1/webhooks/{id}", summary: "Delete an endpoint and its deliveries", tag: "Webhooks", auth: "bearer", scope: "webhooks:manage", status: 204,
    params: Params, response: z.undefined(),
    handler: async ({ deps, key, params, res }) => { const ok = await withTx(deps.pool, (c) => W.deleteEndpoint(c, key!.id, params.id)); if (!ok) throw notFound("webhook endpoint"); res.status(204).end(); return undefined; } }),
  defineRoute({ method: "get", path: "/v1/webhooks/{id}/deliveries", summary: "Deliveries, newest first, dead ones included", tag: "Webhooks", auth: "bearer", scope: "webhooks:manage",
    params: Params, query: PageQuery, response: PagedOf(DeliveryOut),
    handler: async ({ deps, key, params, query }) => withTx(deps.pool, async (c) => {
      if (!(await W.getEndpoint(c, key!.id, params.id))) throw notFound("webhook endpoint");
      const page = await W.listDeliveries(c, params.id, parsePage(query));
      return { data: page.data.map(deliveryOut), next_cursor: page.next_cursor };
    }) }),
  defineRoute({ method: "post", path: "/v1/webhooks/{id}/deliveries/{deliveryId}/retry", summary: "Retry a dead or failed delivery now", tag: "Webhooks", auth: "bearer", scope: "webhooks:manage", status: 202,
    params: Params.extend({ deliveryId: IdParam("whd") }), body: z.object({}).optional(), response: z.object({ scheduled: z.boolean() }),
    handler: async ({ deps, key, params }) => {
      await withTx(deps.pool, async (c) => {
        if (!(await W.getEndpoint(c, key!.id, params.id))) throw notFound("webhook endpoint");
        const d = await W.getDelivery(c, params.deliveryId);
        if (!d || d.endpoint_id !== params.id) throw notFound("delivery");
        await W.recordAttempt(c, d.id, { attempt: 0, status: "pending", responseStatus: null, excerpt: null, nextAttemptAt: new Date() });
      });
      await deps.scheduler.schedule(params.deliveryId, 0);
      return { scheduled: true };
    } }),
];
```

The `DELETE` route ends the response itself and returns `undefined`; make `mountRoutes` skip `res.json` when `res.headersSent` is already true. The `Plutus-Warning` header: in `bearerAuth`, after a key is resolved, run `disabledEndpoints` and, if any, set `res.setHeader("Plutus-Warning", \`disabled webhook endpoints: ${ids.join(",")}\`)`. Wire `QStashScheduler` in `src/deps.ts` when `QSTASH_TOKEN` is present, with `${PUBLIC_BASE_URL}/internal/webhooks/deliver` as the callback; otherwise `MemoryScheduler((id) => deliverOnce(deps, id))` so local development delivers immediately with no retries, and log which.

- [ ] **Step 4: Run, commit**

Run: `npm run build && npx vitest run`
Expected: green. The retry test asserts seven scheduled delays because the eighth failure marks the delivery dead without scheduling.

```bash
git add -A
git commit -m "Signed webhooks with a retry ladder, a dead letter list, and QStash driving the clock"
```

---

### Task 12: OpenAPI from the schemas, Scalar docs, contract tests

**Files:**
- Create: `src/schemas/openapi.ts`, `src/routes/docs.ts`
- Modify: `src/routes/index.ts`, `src/app.ts` (mount docs after routes)
- Test: `tests/contract/openapi.test.ts`, `tests/contract/responses.test.ts`

**Interfaces:**
- Produces: `buildOpenApi(routes: RouteDef[], baseUrl: string): OpenApiDocument` in `src/schemas/openapi.ts`, using `z.toJSONSchema` from zod 4 on every `params`, `query`, `body` and `response`. Routes under `/internal` are excluded. Every operation documents `401`, `404`, `422` and `429` with the `Problem` schema, plus `409` for routes with `idempotent: true`.
- Routes: `GET /openapi.json` (no auth, no limit) and `GET /docs` (Scalar).

- [ ] **Step 1: Failing contract tests**

`tests/contract/openapi.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { ROUTE_REGISTRY } from "../../src/platform/route.js";

describe("openapi.json", () => {
  it("is a 3.1 document that names every public route and no internal one", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.info.title).toBe("Plutus");
    const documented = Object.entries(res.body.paths).flatMap(([p, ops]) => Object.keys(ops as object).map((m) => `${m.toUpperCase()} ${p}`));
    for (const r of ROUTE_REGISTRY) {
      const line = `${r.method.toUpperCase()} ${r.path}`;
      if (r.path.startsWith("/internal")) expect(documented).not.toContain(line);
      else expect(documented).toContain(line);
    }
    const transfer = res.body.paths["/v1/ledgers/{id}/transfers"].post;
    expect(transfer.requestBody.content["application/json"].schema.properties.legs.items.properties.amount.type).toBe("string");
    expect(transfer.responses["409"]).toBeDefined();
    expect(transfer.security).toEqual([{ bearer: [] }]);
    expect(res.body.components.securitySchemes.bearer.scheme).toBe("bearer");
  });
  it("renders the reference page", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/docs");
    expect(res.status).toBe(200);
    expect(res.text).toContain("openapi.json");
  });
});
```

`tests/contract/responses.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import { ROUTE_REGISTRY } from "../../src/platform/route.js";
import { Problem } from "../../src/schemas/common.js";

function schemaFor(method: string, path: string) {
  const r = ROUTE_REGISTRY.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`no route ${method} ${path}`);
  return r.response;
}

describe("responses match their declared schemas", () => {
  it("across a whole ledger session", async () => {
    const { app } = await makeTestApp();
    const minted = await request(app).post("/v1/keys").send();
    expect(schemaFor("post", "/v1/keys").safeParse(minted.body).success).toBe(true);
    const h = bearer(minted.body.secret);
    const l = await request(app).post("/v1/ledgers").set(h).send({ name: "c" });
    expect(schemaFor("post", "/v1/ledgers").safeParse(l.body).success).toBe(true);
    const a = await request(app).post(`/v1/ledgers/${l.body.id}/accounts`).set(h).send({ asset: "USD", name: "a" });
    expect(schemaFor("post", "/v1/ledgers/{id}/accounts").safeParse(a.body).success).toBe(true);
    const t = await request(app).post(`/v1/ledgers/${l.body.id}/transfers`).set(h).send({ legs: [{ from: "world:USD", to: a.body.id, asset: "USD", amount: "10" }] });
    expect(schemaFor("post", "/v1/ledgers/{id}/transfers").safeParse(t.body).success).toBe(true);
    const hold = await request(app).post(`/v1/ledgers/${l.body.id}/holds`).set(h).send({ account: a.body.id, amount: "5" });
    expect(schemaFor("post", "/v1/ledgers/{id}/holds").safeParse(hold.body).success).toBe(true);
    const v = await request(app).get(`/v1/ledgers/${l.body.id}/verify`).set(h);
    expect(schemaFor("get", "/v1/ledgers/{id}/verify").safeParse(v.body).success).toBe(true);
    const j = await request(app).get(`/v1/ledgers/${l.body.id}/journal`).set(h);
    expect(schemaFor("get", "/v1/ledgers/{id}/journal").safeParse(j.body).success).toBe(true);
    const e = await request(app).get("/v1/events").set(h);
    expect(schemaFor("get", "/v1/events").safeParse(e.body).success).toBe(true);
    const bad = await request(app).post(`/v1/ledgers/${l.body.id}/transfers`).set(h).send({ legs: [] });
    expect(Problem.safeParse(bad.body).success).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

`src/schemas/openapi.ts`:
```ts
import { z } from "zod";
import type { RouteDef } from "../platform/route.js";
import { Problem } from "./common.js";

type Json = Record<string, unknown>;
const schemaOf = (s: z.ZodType): Json => z.toJSONSchema(s, { target: "draft-2020-12", io: "output" }) as Json;
const inputSchemaOf = (s: z.ZodType): Json => z.toJSONSchema(s, { target: "draft-2020-12", io: "input" }) as Json;

function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([a-zA-Z_]+)\}/g)].map((m) => m[1] as string);
}

export function buildOpenApi(routes: RouteDef[], baseUrl: string): Json {
  const paths: Record<string, Record<string, Json>> = {};
  const problem = { description: "Problem details", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } };
  for (const r of routes) {
    if (r.path.startsWith("/internal")) continue;
    const params: Json[] = pathParams(r.path).map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));
    if (r.query) {
      const q = inputSchemaOf(r.query);
      const props = (q.properties ?? {}) as Record<string, Json>;
      const required = new Set((q.required ?? []) as string[]);
      for (const [name, schema] of Object.entries(props)) params.push({ name, in: "query", required: required.has(name), schema });
    }
    const responses: Record<string, Json> = {
      [String(r.status ?? 200)]: r.status === 204 ? { description: "No content" } : { description: "Success", content: { "application/json": { schema: schemaOf(r.response) } } },
      "422": problem, "429": problem,
    };
    if (r.auth === "bearer") { responses["401"] = problem; responses["403"] = problem; }
    if (pathParams(r.path).length > 0) responses["404"] = problem;
    if (r.idempotent) responses["409"] = problem;
    const op: Json = {
      summary: r.summary, tags: [r.tag], operationId: `${r.method}_${r.path.replaceAll(/[^a-zA-Z0-9]+/g, "_")}`,
      parameters: params, responses,
      ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: inputSchemaOf(r.body) } } } } : {}),
      ...(r.auth === "bearer" ? { security: [{ bearer: [] }] } : {}),
    };
    if (r.idempotent) (op.parameters as Json[]).push({ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 255 } });
    paths[r.path] ??= {};
    paths[r.path]![r.method] = op;
  }
  return {
    openapi: "3.1.0",
    info: { title: "Plutus", version: "1.0.0", description: "A multi asset ledger and paper trading exchange API. Amounts are strings of minor units. Every list is cursor paginated. Every error is a problem details document with a stable code." },
    servers: [{ url: baseUrl }],
    tags: ["Meta", "Assets", "Keys", "Ledgers", "Accounts", "Transfers", "Holds", "Journal", "Events", "Webhooks"].map((name) => ({ name })),
    paths,
    components: {
      schemas: { Problem: schemaOf(Problem) },
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "Authorization: Bearer pl_test_... or pl_live_..." } },
    },
  };
}
```

`src/routes/docs.ts`:
```ts
import { z } from "zod";
import { apiReference } from "@scalar/express-api-reference";
import type { Express } from "express";
import { defineRoute, ROUTE_REGISTRY } from "../platform/route.js";
import { buildOpenApi } from "../schemas/openapi.js";
import type { AppDeps } from "../deps.js";

let cached: Record<string, unknown> | null = null;

export const docsRoutes = [
  defineRoute({
    method: "get", path: "/openapi.json", summary: "The OpenAPI 3.1 document, generated from the same schemas that validate requests", tag: "Meta", auth: "none", limit: "none",
    response: z.record(z.string(), z.unknown()),
    handler: async ({ deps }) => { cached ??= buildOpenApi(ROUTE_REGISTRY, deps.config.PUBLIC_BASE_URL); return cached; },
  }),
];

/** Mounted separately because Scalar is Express middleware, not a route with a schema. */
export function mountDocs(app: Express, _deps: AppDeps): void {
  app.use("/docs", apiReference({ url: "/openapi.json", theme: "kepler", pageTitle: "Plutus API" }));
}
```

Check the installed `@scalar/express-api-reference` README for the exact option name (`url` versus `spec.url`) before trusting the line above; adapt to what the installed version exports and record it in the report. Call `mountDocs(app, deps)` in `createApp` after `mountRoutes` and before the not found handler. Add `docsRoutes` to `allRoutes` last, so the registry is complete when the document is first built.

- [ ] **Step 3: Run, commit**

Run: `npm run build && npx vitest run`
Expected: green. If `z.toJSONSchema` throws on `z.record` with a regex key or on `.refine`, zod 4 emits refinements as plain base types; that is acceptable for docs, but a thrown error is not: set `unrepresentable: "any"` in the options and note it.

```bash
git add -A
git commit -m "OpenAPI generated from the validating schemas, a Scalar reference, and contract tests"
```

---

### Task 13: Property tests, the HTTP race, and the mutation script

**Files:**
- Create: `tests/property/ledger.property.test.ts`, `tests/integration/http-race.test.ts`, `scripts/mutate.mjs`
- Modify: `package.json` (add `"test:mutation": "node scripts/mutate.mjs"`)

**Interfaces:**
- Produces: `npm run test:mutation`, which applies three deliberate breakages to a scratch copy of the SQL functions in the test database, runs the test that should catch each, and exits non zero if any test stays green.

- [ ] **Step 1: The property suite**

`tests/property/ledger.property.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";
import { withTx } from "../../src/db/pool.js";
import * as L from "../../src/db/ledger.js";
import { verifyChain } from "../../src/domain/verify.js";

type Op =
  | { kind: "fund"; account: number; amount: bigint }
  | { kind: "transfer"; from: number; to: number; amount: bigint }
  | { kind: "hold"; account: number; amount: bigint }
  | { kind: "capture"; hold: number; amount: bigint; releaseRemainder: boolean }
  | { kind: "release"; hold: number };

const amount = fc.bigInt({ min: 1n, max: 5_000n });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("fund" as const), account: fc.nat(3), amount }),
  fc.record({ kind: fc.constant("transfer" as const), from: fc.nat(3), to: fc.nat(3), amount }),
  fc.record({ kind: fc.constant("hold" as const), account: fc.nat(3), amount }),
  fc.record({ kind: fc.constant("capture" as const), hold: fc.nat(20), amount, releaseRemainder: fc.boolean() }),
  fc.record({ kind: fc.constant("release" as const), hold: fc.nat(20) }),
);

describe("ledger invariants under random operation sequences", () => {
  it("conservation, non negative available, held equals open holds, chain verifies", async () => {
    const { app, deps } = await makeTestApp();
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 20, maxLength: 60 }), async (ops) => {
      const k = await mintKey(app);
      const h = bearer(k.secret);
      const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "p" })).body;
      const accounts: string[] = [];
      for (let i = 0; i < 4; i++) accounts.push((await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: `a${i}` })).body.id);
      const holds: string[] = [];
      for (const op of ops) {
        if (op.kind === "fund") await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:GHS", to: accounts[op.account], asset: "GHS", amount: op.amount.toString() }] });
        else if (op.kind === "transfer") await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: accounts[op.from], to: accounts[op.to], asset: "GHS", amount: op.amount.toString() }] });
        else if (op.kind === "hold") { const r = await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: accounts[op.account], amount: op.amount.toString() }); if (r.status === 201) holds.push(r.body.id); }
        else if (op.kind === "capture" && holds.length) await request(app).post(`/v1/ledgers/${l.id}/holds/${holds[op.hold % holds.length]}/capture`).set(h).send({ to: accounts[0], amount: op.amount.toString(), release_remainder: op.releaseRemainder });
        else if (op.kind === "release" && holds.length) await request(app).post(`/v1/ledgers/${l.id}/holds/${holds[op.hold % holds.length]}/release`).set(h).send({});
      }
      // Every response is either a success or a well formed refusal; the invariants must hold regardless.
      const { rows } = await deps.pool.query<{ id: string; kind: string; balance: string; held: string; open_held: string }>(
        `select a.id, a.kind, a.balance::text, a.held::text,
                coalesce((select sum(remaining) from holds hh where hh.account_id = a.id and hh.status = 'open'), 0)::text as open_held
         from accounts a where a.ledger_id = $1`, [l.id]);
      let sum = 0n;
      for (const r of rows) {
        sum += BigInt(r.balance);
        expect(BigInt(r.held)).toBe(BigInt(r.open_held));
        if (r.kind === "normal") expect(BigInt(r.balance) - BigInt(r.held) >= 0n).toBe(true);
      }
      expect(sum).toBe(0n);
      const stored = new Map(rows.map((r) => [r.id, { balance: BigInt(r.balance), held: BigInt(r.held) }]));
      const report = await withTx(deps.pool, async (c) => {
        async function* entries() { let since = 0n; for (;;) { const b = await L.listJournal(c, l.id, since, 500); if (!b.length) return; yield* b; since = BigInt(b[b.length - 1]!.seq); } }
        return verifyChain(entries(), stored);
      });
      expect(report.ok).toBe(true);
    }), { numRuns: 25, endOnFailure: true });
  }, 300_000);
});
```

Twenty five runs of up to sixty operations each is a few thousand HTTP calls against a real database; expect two to four minutes locally. It runs in its own CI step.

- [ ] **Step 2: The HTTP race and the mutation script**

`tests/integration/http-race.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";

describe("the race, through the API", () => {
  it("parallel captures of one hold never overdraw it", async () => {
    const { app } = await makeTestApp();
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "r" })).body;
    const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "USD", name: "a" })).body;
    const b = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "USD", name: "b" })).body;
    await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:USD", to: a.id, asset: "USD", amount: "1000" }] });
    const hold = (await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: a.id, amount: "500" })).body;
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      request(app).post(`/v1/ledgers/${l.id}/holds/${hold.id}/capture`).set(h).send({ to: b.id, amount: "100" })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    const bb = await request(app).get(`/v1/ledgers/${l.id}/accounts/${b.id}`).set(h);
    expect(bb.body.balance).toBe("500");
    const v = await request(app).get(`/v1/ledgers/${l.id}/verify`).set(h);
    expect(v.body.ok).toBe(true);
  });
});
```

`scripts/mutate.mjs`:
```js
// Applies deliberate breakages to the SQL functions in the test database and
// asserts the suite goes red for each. A test that survives a mutation is a
// test that proves nothing. Run: npm run test:mutation (needs TEST_DATABASE_URL).
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) { process.stderr.write("TEST_DATABASE_URL is required; start a database first\n"); process.exit(1); }
const original = readFileSync("db/migrations/0005_ledger_functions.sql", "utf8");

const MUTATIONS = [
  {
    name: "no account locks",
    sql: original.replace("perform 1 from accounts where id = any(v_ids) order by id for update;", "perform 1;"),
    test: "tests/integration/concurrency.test.ts",
  },
  {
    name: "overdraft allowed",
    sql: original.replace("v_from_row.balance - v_from_row.held < v_amount", "false"),
    test: "tests/integration/ledger-functions.test.ts",
  },
  {
    name: "hash ignores payload",
    sql: original.replace("v_hash := sha256(v_prev || convert_to(canonical_json(v_payload), 'UTF8'));", "v_hash := sha256(v_prev);"),
    test: "tests/integration/verify.test.ts",
  },
];

const client = new pg.Client({ connectionString: url });
await client.connect();
let failed = 0;
for (const m of MUTATIONS) {
  if (m.sql === original) { process.stderr.write(`mutation "${m.name}" did not change the SQL; the anchor text moved\n`); failed++; continue; }
  await client.query(m.sql);
  const run = spawnSync("npx", ["vitest", "run", m.test], { stdio: "pipe", env: process.env, shell: true });
  const red = run.status !== 0;
  process.stdout.write(`${red ? "caught" : "MISSED"}  ${m.name}\n`);
  if (!red) failed++;
  await client.query(original);
}
await client.end();
process.exit(failed ? 1 : 0);
```

The global setup starts its own database when `TEST_DATABASE_URL` is unset, which the script cannot see. For local runs, start one once with a small helper or point `TEST_DATABASE_URL` at the Neon test branch from Task 3. In CI the service container's URL is already set, so add `- run: npm run test:mutation` to the `test` job after the contract step.

- [ ] **Step 3: Run, commit**

Run: `npx vitest run tests/property tests/integration/http-race.test.ts` then `npm run test:mutation`
Expected: property and race green; mutation prints `caught` three times and exits 0.

```bash
git add -A
git commit -m "Property tests over random operation sequences, the race through the API, and mutations that must go red"
```

---

### Task 14: The sweep, the landing page, the README, and the deployment

**Files:**
- Modify: `src/routes/internal.ts` (add the sweep), `src/db/ledger.ts` (add `ledgersWithExpiredHolds`, `deleteIdleSandbox`), `src/db/idempotency.ts` (add `purgeExpired`), `src/db/events.ts` (add `purgeOld`)
- Create: `public/index.html`, `docs/verify-webhook.mjs` (the twelve line verifier the README links)
- Modify: `README.md` (the real one)
- Test: `tests/integration/sweep.test.ts`, plus a live smoke checklist recorded in the task report

**Interfaces:**
- Route: `POST /internal/sweep` and `GET /internal/sweep` (Vercel cron sends GET), guarded by `Authorization: Bearer ${CRON_SECRET}`. Returns `{ expired_holds, deleted_ledgers, deleted_keys, deleted_events, deleted_idempotency, republished_deliveries }`.

- [ ] **Step 1: Failing test**

`tests/integration/sweep.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { mintKey, bearer } from "../helpers/keys.js";

describe("the sweep", () => {
  it("refuses without the secret and reports what it did with it", async () => {
    const { app, deps } = await makeTestApp();
    expect((await request(app).get("/internal/sweep")).status).toBe(401);
    const k = await mintKey(app);
    const h = bearer(k.secret);
    const l = (await request(app).post("/v1/ledgers").set(h).send({ name: "s" })).body;
    const a = (await request(app).post(`/v1/ledgers/${l.id}/accounts`).set(h).send({ asset: "GHS", name: "a" })).body;
    await request(app).post(`/v1/ledgers/${l.id}/transfers`).set(h).send({ legs: [{ from: "world:GHS", to: a.id, asset: "GHS", amount: "100" }] });
    const hold = (await request(app).post(`/v1/ledgers/${l.id}/holds`).set(h).send({ account: a.id, amount: "10" })).body;
    await deps.pool.query("update holds set expires_at = now() - interval '1 minute' where id = $1", [hold.id]);
    const idle = await mintKey(app);
    const il = (await request(app).post("/v1/ledgers").set(bearer(idle.secret)).send({ name: "idle" })).body;
    await deps.pool.query("update ledgers set last_activity_at = now() - interval '15 days' where id = $1", [il.id]);
    await deps.pool.query("update api_keys set last_used_at = now() - interval '31 days', created_at = now() - interval '31 days' where id = $1", [idle.id]);
    const res = await request(app).get("/internal/sweep").set("Authorization", `Bearer ${deps.config.CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.expired_holds).toBeGreaterThanOrEqual(1);
    expect(res.body.deleted_ledgers).toBeGreaterThanOrEqual(1);
    expect(res.body.deleted_keys).toBeGreaterThanOrEqual(1);
    expect((await request(app).get("/v1/keys/me").set(bearer(idle.secret))).status).toBe(401);
    expect((await request(app).get(`/v1/ledgers/${l.id}/holds/${hold.id}`).set(h)).body.status).toBe("expired");
  });
});
```

- [ ] **Step 2: Implement the sweep**

Add to `src/db/ledger.ts`:
```ts
export async function ledgersWithExpiredHolds(c: PoolClient): Promise<string[]> {
  const { rows } = await c.query<{ ledger_id: string }>("select distinct ledger_id from holds where status = 'open' and expires_at <= now() limit 500");
  return rows.map((r) => r.ledger_id);
}
export async function deleteIdleSandbox(c: PoolClient): Promise<{ ledgers: number; keys: number }> {
  const l = await c.query("delete from ledgers l using api_keys k where k.id = l.key_id and k.mode = 'test' and l.last_activity_at < now() - interval '14 days'");
  const k = await c.query("delete from api_keys where mode = 'test' and coalesce(last_used_at, created_at) < now() - interval '30 days'");
  return { ledgers: l.rowCount ?? 0, keys: k.rowCount ?? 0 };
}
```
Add `purgeExpired(c)` to `src/db/idempotency.ts` (`delete from idempotency_keys where expires_at < now()`) and `purgeOld(c)` to `src/db/events.ts` (`delete from events where created_at < now() - interval '30 days'`), each returning the row count.

Append to `internalRoutes` in `src/routes/internal.ts`, once for `get` and once for `post` with the same handler:
```ts
const SweepOut = z.object({ expired_holds: z.number().int(), deleted_ledgers: z.number().int(), deleted_keys: z.number().int(), deleted_events: z.number().int(), deleted_idempotency: z.number().int(), republished_deliveries: z.number().int() });

async function sweep({ deps, req }: { deps: AppDeps; req: import("express").Request }) {
  const secret = deps.config.CRON_SECRET;
  if (!secret || req.header("authorization") !== `Bearer ${secret}`) throw new ApiError(401, "unauthorized", "internal route");
  const out = await withTx(deps.pool, async (c) => {
    let expired = 0;
    for (const id of await L.ledgersWithExpiredHolds(c)) expired += await L.expireHolds(c, id, null);
    const idle = await L.deleteIdleSandbox(c);
    const events = await purgeOld(c);
    const idem = await purgeExpired(c);
    const stale = await W.stalePending(c, 60);
    return { expired_holds: expired, deleted_ledgers: idle.ledgers, deleted_keys: idle.keys, deleted_events: events, deleted_idempotency: idem, stale };
  });
  for (const id of out.stale) await deps.scheduler.schedule(id, 0);
  const { stale, ...rest } = out;
  return { ...rest, republished_deliveries: stale.length };
}
```
with `defineRoute({ method: "get", path: "/internal/sweep", summary: "Daily housekeeping", tag: "Internal", auth: "none", limit: "none", response: SweepOut, handler: sweep })` and the same for `post`. Import `AppDeps`, `withTx`, `L`, `W`, `purgeOld`, `purgeExpired` at the top of the file.

- [ ] **Step 3: The landing page and the verifier**

`public/index.html` is a single static page, no framework, no external assets except the two Google Fonts links the design rules permit. Content, in order: the wordmark "plutus"; one sentence, "A ledger you can audit and an exchange you can trade against."; three short paragraphs saying what it is, that money is integer minor units and every write is one Postgres function under row locks, and that the journal is a hash chain anyone can verify; a `<pre>` block with the thirty second quickstart below; links to `/docs`, `/openapi.json`, `/health`, and the GitHub repository; the licence line. Palette: ground `#FBFAF7`, ink `#1F2A24`, accent `#1C6E4A`, muted `#5D6B63`, one accent only, radius 14px on the code block and nothing rounded fully. Type: Outfit for the wordmark and headings, Nunito for body, monospace for the quickstart. Dark mode through `prefers-color-scheme` with ground `#141915`, ink `#EEF2EE`, accent `#7CC7A0`. No emoji, no dashes, no icons.

The quickstart, verbatim (the reader replaces nothing but the key):
```
# 1. a key, no signup
curl -s -X POST https://plutus.atilladev.com/v1/keys
# 2. a ledger and two accounts
curl -s -X POST https://plutus.atilladev.com/v1/ledgers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"name":"shop"}'
curl -s -X POST https://plutus.atilladev.com/v1/ledgers/$LEDGER/accounts -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"asset":"GHS","name":"till"}'
# 3. money in from the world, then between accounts
curl -s -X POST https://plutus.atilladev.com/v1/ledgers/$LEDGER/transfers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Idempotency-Key: fund-1" -d '{"legs":[{"from":"world:GHS","to":"'$TILL'","asset":"GHS","amount":"125000"}]}'
# 4. prove the books
curl -s https://plutus.atilladev.com/v1/ledgers/$LEDGER/verify -H "Authorization: Bearer $KEY"
```
Use the real deployment host once Task 14 step 5 assigns it; until then keep `plutus.atilladev.com` as the placeholder and replace it in the same commit as the deploy.

`docs/verify-webhook.mjs`:
```js
// Verify a Plutus webhook. Twelve lines, no dependencies. Node 18 or later.
import { createHmac, timingSafeEqual } from "node:crypto";
export function verifyPlutusWebhook(secret, signatureHeader, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(signatureHeader.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(String(parts.v1 ?? ""), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

- [ ] **Step 4: The README**

Replace `README.md` entirely. Sections, in order: title and one line; the CI badge (`![ci](https://github.com/atilladev-owner/Plutus/actions/workflows/ci.yml/badge.svg)`); "What it is" in four sentences; "Thirty seconds" with the quickstart above; "What a stranger can verify" listing the verify endpoint, the concurrency test file, the mutation script and the CI run; "How webhooks are signed" with the header format and a link to `docs/verify-webhook.mjs`; "Limits" as a table copied from the spec's section 9.2; "Running it locally" (`cp .env.example .env`, `npm install`, `npm run migrate`, `npm run dev`, `npm test`); "Design" linking the spec and this plan; "Licence". No emoji, no dashes as punctuation, no claims the code does not make.

- [ ] **Step 5: Deploy, then prove it live**

Do these by hand on the owner's machine, in order, and paste the observed outputs into the task report. Never paste a secret into chat or into any file that is not gitignored.

1. Neon: create project `plutus`, region US East, database `plutus`. Copy the pooled and direct URLs into `.env`.
2. Upstash: create a Redis database (free, region US East) and a QStash token. Copy the REST URL and token, the QStash token and both signing keys into `.env`.
3. `npm run migrate` against Neon. Expected: `applied: 0001_functions.sql, ... 0008_webhooks.sql`.
4. `npx vercel link` (create project `plutus`), then `npx vercel env add` for every variable in `.env.example`, Production and Preview, plus `CRON_SECRET` as 32 random characters from `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`. Set `PUBLIC_BASE_URL` to the production URL Vercel assigns.
5. `npx vercel deploy --prod`. Record the URL. Replace the placeholder host in `public/index.html` and `README.md`, commit, and add the four GitHub secrets (`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` from `.vercel/project.json`, `DATABASE_URL_UNPOOLED`) so the CI deploy job goes green on the next push.
6. Smoke, against the live URL, with the observed output recorded:
   - `GET /health` returns 200 with both checks `ok: true`.
   - The quickstart runs end to end with a freshly minted key; verify returns `ok: true`.
   - Mint six keys from one machine inside an hour; the sixth is a 429 with `Retry-After`.
   - Register a webhook pointing at a request bin (any https receiver you control), post a transfer, and see one signed delivery arrive; run the verifier against it. Then point an endpoint at a URL that returns 500, post a transfer, and watch `GET /v1/webhooks/{id}/deliveries` move through attempts over the next hour, driven by QStash. You do not need to wait a day: confirm attempt 3 has happened, and that `next_attempt_at` matches the schedule.
   - `GET /docs` renders. `GET /openapi.json` validates at `https://editor.swagger.io` with no errors.
   - Trigger the cron once by hand with `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/internal/sweep` and confirm a 200 with counts.
7. Add the project to the portfolio: `slug: "plutus"`, title "Plutus", meta "Live · Public source", stack `["Node.js", "Express 5", "TypeScript", "PostgreSQL", "Neon", "Upstash", "Vercel", "Vitest", "Playwright"]` minus Playwright since there is none here, stats `["307 tests" replaced by the real count, "Row locked transfers", "Hash chained journal", "Public source"]`, `liveUrl` the landing page, `liveLabel` "Open the API", `sourceNote` "Public source under PolyForm Noncommercial. Mint a key and try it."

- [ ] **Step 6: Commit and push**

```bash
git add -A
git commit -m "The daily sweep, the landing page, the README, and the first production deployment"
git push
```

Milestone one is done when every acceptance criterion in the spec's section 3 has an observed output in a task report, and the CI badge on the README is green.

---

## Self review against the spec

**Spec coverage.** Section 5.2 assets: Task 3. 5.3 keys, rotation and the live key script: Task 6. 5.4 to 5.8 ledgers, accounts, transfers, holds, journal, chain: Tasks 3, 4, 9. 5.9 events: Tasks 4 and 9. Section 6 invariants: enforced in Task 4's constraints and functions, asserted in Task 13. Section 7 conventions: Task 5 (errors, request ids, body limits, content type), Task 8 (idempotency), Task 9 (pagination). Section 8 surface: Tasks 6, 9, 10, 11, 12, 14. 9.1 rate limits: Task 7. 9.2 ceilings: Tasks 4 (journal entries, open holds), 9 (ledgers, accounts), 11 (endpoints), 5 (body size), 14 (idle deletion). 9.3 webhooks: Task 11. 9.4 observability: Task 5 (logs, request id, health); Sentry is deliberately left to the deploy step because it needs a DSN and adds nothing a test can prove. 9.5 security: Tasks 1 (house rules), 5 (helmet, limits), 6 (constant time), 11 (https only). 9.6 configuration: Task 1. Section 11 storage: Task 3. Section 12 testing: Tasks 3 (real Postgres), 13 (property, mutation), 12 (contract), 1 (CI). Section 13 deployment: Tasks 1 and 14. Section 14 documents: Task 14, and `docs/how-it-works.md` is written after milestone two as the spec says.

**Gaps, named.** The `/health` count of the day's QStash messages (spec 9.3) is not built; `/health` reports Redis and Postgres only. Sentry wiring is a deploy step, not a task. Both are recorded here rather than hidden.

**Type consistency.** `WriteResult.event_ids` is the field every write returns and `afterCommit` consumes. `Paged<T>` and `Page` are defined once in `src/db/ledger.ts` and imported by events and webhooks. `AuthedKey` is declared in `src/platform/route.ts` and re exported by `src/platform/auth.ts`. `RouteMiddleware` factories take a `RouteDef` and return an Express handler in Tasks 5 through 8. `deliverOnce(deps, id)` is the signature used by the memory scheduler in tests, by `deps.ts` locally, and by the QStash callback.

