// Applies five deliberate breakages to the SQL functions in the test database and
// asserts the suite goes red for each. A test that survives a mutation is a test that
// proves nothing. Run: npm run test:mutation (needs TEST_DATABASE_URL). The five:
//   closed hold released again: release_hold no longer refuses a hold that is not open,
//     so a closed hold can be released a second time.
//   overdraft allowed: post_transfer's available balance check never refuses a leg.
//   hash ignores payload: append_journal's hash no longer covers the entry payload.
//   fill without the base leg: place_order's fill transfer drops the base asset leg, so
//     a fill moves the quote side of a trade without ever moving the base side.
//   fee rounds down: exchange_fee drops its plus 9999 numerator bump, so a fee that
//     should ceil now floors instead.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) { process.stderr.write("TEST_DATABASE_URL is required; start a database first\n"); process.exit(1); }

const FILES = {
  ledgerFunctions: "db/migrations/0005_ledger_functions.sql",
  houseLadder: "db/migrations/0016_house_ladder.sql",
};
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([key, path]) => [key, readFileSync(path, "utf8")]));

// This guard, keyed on v_hold.status, appears only in release_hold; post_transfer's
// equivalent check reads v_hold_row.status, a different variable, so a plain string
// replace on the three line block cannot land on the wrong function.
const RELEASE_HOLD_GUARD = "  if v_hold.status <> 'open' then\n    raise exception 'hold_not_open' using detail = v_hold.status;\n  end if;\n";

// place_order's own fill transfer, db/migrations/0013_place_order.sql originally, replaced
// in place by 0016_house_ladder.sql for the notional_too_large amendment; this text is
// unchanged by that amendment, so it still names the same three legs, but 0016 is the file
// whose place_order actually runs, since a later create or replace wins. Confirmed to
// appear exactly once in that file: the base asset leg, third of the three, closing the
// jsonb_build_array place_order hands to post_transfer for every fill.
const FILL_BASE_LEG = `        jsonb_build_object('from_hold', v_buyer_hold, 'to', v_fee_account, 'asset', v_market.quote, 'amount', (v_seller_fee + v_buyer_fee)::text),
        jsonb_build_object('from_hold', v_seller_hold, 'to', v_buyer_account, 'asset', v_market.base, 'amount', v_fill_qty::text)
      ), 'exchange fill',`;
const FILL_WITHOUT_BASE_LEG = `        jsonb_build_object('from_hold', v_buyer_hold, 'to', v_fee_account, 'asset', v_market.quote, 'amount', (v_seller_fee + v_buyer_fee)::text)
      ), 'exchange fill',`;

// exchange_fee's own latest definition, also replaced in place by 0016_house_ladder.sql
// (the numeric rewrite that stops its own p_notional times p_bps product from overflowing
// bigint on a very large notional). The plus 9999 numerator bump is what turns numeric
// division into a ceiling; dropping it leaves a plain floor.
const FEE_CEIL_BUMP = "p_notional::numeric * p_bps + 9999";
const FEE_FLOOR = "p_notional::numeric * p_bps";

const MUTATIONS = [
  {
    name: "closed hold released again",
    file: "ledgerFunctions",
    sql: ORIGINALS.ledgerFunctions.replace(RELEASE_HOLD_GUARD, ""),
    test: "tests/integration/ledger-functions.test.ts",
  },
  {
    name: "overdraft allowed",
    file: "ledgerFunctions",
    sql: ORIGINALS.ledgerFunctions.replace("v_from_row.balance - v_from_row.held < v_amount", "false"),
    test: "tests/integration/ledger-functions.test.ts",
  },
  {
    name: "hash ignores payload",
    file: "ledgerFunctions",
    sql: ORIGINALS.ledgerFunctions.replace("v_hash := sha256(v_prev || convert_to(canonical_json(v_payload), 'UTF8'));", "v_hash := sha256(v_prev);"),
    test: "tests/integration/verify.test.ts",
  },
  {
    name: "fill without the base leg",
    file: "houseLadder",
    sql: ORIGINALS.houseLadder.replace(FILL_BASE_LEG, FILL_WITHOUT_BASE_LEG),
    test: "tests/integration/matching.test.ts",
  },
  {
    name: "fee rounds down",
    file: "houseLadder",
    sql: ORIGINALS.houseLadder.replace(FEE_CEIL_BUMP, FEE_FLOOR),
    test: "tests/integration/matching.test.ts",
  },
];

const client = new pg.Client({ connectionString: url });
await client.connect();

// A thrown spawnSync, or the process itself being killed mid mutation, must never leave
// a mutated function live in whatever database TEST_DATABASE_URL points at. The loop
// body below restores in a finally so a thrown spawnSync still restores before the
// error propagates; these handlers cover the process being signalled outright, restoring
// every file's own original since either one could be the one currently mutated.
async function restoreAndExit(signal) {
  try {
    for (const original of Object.values(ORIGINALS)) await client.query(original);
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
  const original = ORIGINALS[m.file];
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
