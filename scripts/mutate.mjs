// Applies deliberate breakages to the SQL functions in the test database and
// asserts the suite goes red for each. A test that survives a mutation is a
// test that proves nothing. Run: npm run test:mutation (needs TEST_DATABASE_URL).
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) { process.stderr.write("TEST_DATABASE_URL is required; start a database first\n"); process.exit(1); }
const original = readFileSync("db/migrations/0005_ledger_functions.sql", "utf8");

// The row lock line that opens expire_holds is byte identical to the one that opens
// post_transfer, create_hold and release_hold, so a plain string replace on the whole
// file would hit whichever of those comes first instead of expire_holds. The file is
// split at the expire_holds header first, and only the occurrence after that header
// is removed.
const EXPIRE_HOLDS_HEADER = "create or replace function expire_holds(";
const LEDGER_LOCK_LINE = "  perform 1 from ledgers where id = p_ledger_id for update;\n";
function sweepWithoutLedgerLock() {
  const at = original.indexOf(EXPIRE_HOLDS_HEADER);
  if (at === -1) return original;
  const before = original.slice(0, at);
  const after = original.slice(at);
  return before + after.replace(LEDGER_LOCK_LINE, "");
}

const MUTATIONS = [
  {
    name: "sweep without the ledger lock",
    sql: sweepWithoutLedgerLock(),
    test: "tests/integration/ledger-functions.test.ts",
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
