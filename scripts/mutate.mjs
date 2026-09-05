// Applies three deliberate breakages to the SQL functions in the test database and
// asserts the suite goes red for each. A test that survives a mutation is a test that
// proves nothing. Run: npm run test:mutation (needs TEST_DATABASE_URL). The three:
//   closed hold released again: release_hold no longer refuses a hold that is not open,
//     so a closed hold can be released a second time.
//   overdraft allowed: post_transfer's available balance check never refuses a leg.
//   hash ignores payload: append_journal's hash no longer covers the entry payload.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) { process.stderr.write("TEST_DATABASE_URL is required; start a database first\n"); process.exit(1); }
const original = readFileSync("db/migrations/0005_ledger_functions.sql", "utf8");

// This guard, keyed on v_hold.status, appears only in release_hold; post_transfer's
// equivalent check reads v_hold_row.status, a different variable, so a plain string
// replace on the three line block cannot land on the wrong function.
const RELEASE_HOLD_GUARD = "  if v_hold.status <> 'open' then\n    raise exception 'hold_not_open' using detail = v_hold.status;\n  end if;\n";

const MUTATIONS = [
  {
    name: "closed hold released again",
    sql: original.replace(RELEASE_HOLD_GUARD, ""),
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

// A thrown spawnSync, or the process itself being killed mid mutation, must never leave
// a mutated function live in whatever database TEST_DATABASE_URL points at. The loop
// body below restores in a finally so a thrown spawnSync still restores before the
// error propagates; these handlers cover the process being signalled outright.
async function restoreAndExit(signal) {
  try {
    await client.query(original);
    process.stderr.write(`${signal} received; restored the original SQL before exiting\n`);
  } catch (err) {
    process.stderr.write(`${signal} received; failed to restore the original SQL: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
}
process.on("SIGINT", () => { void restoreAndExit("SIGINT"); });
process.on("SIGTERM", () => { void restoreAndExit("SIGTERM"); });

let failed = 0;
for (const m of MUTATIONS) {
  if (m.sql === original) { process.stderr.write(`mutation "${m.name}" did not change the SQL; the anchor text moved\n`); failed++; continue; }
  try {
    await client.query(m.sql);
    const run = spawnSync("npx", ["vitest", "run", m.test], { stdio: "pipe", env: process.env, shell: true });
    const red = run.status !== 0;
    process.stdout.write(`${red ? "caught" : "MISSED"}  ${m.name}\n`);
    if (!red) failed++;
  } finally {
    await client.query(original);
  }
}
await client.end();
process.exit(failed ? 1 : 0);
