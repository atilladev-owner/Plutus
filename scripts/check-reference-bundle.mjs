// Fetches the API reference bundle from the exact CDN URL src/routes/docs.ts pins, hashes
// it, and compares that with the integrity value pinned beside it.
//
// Review round 1, finding 6: the contract test asserts the shape of the integrity attribute
// on the rendered script tag, which is what catches the string replacement silently doing
// nothing, but any well formed base64 passes it. The failure worth catching is the other one:
// a bumped CDN pin with a stale hash. That does not degrade the reference page, it stops the
// browser executing the bundle at all and /docs renders blank, and no test against a local
// database can see it. So it belongs in CI, where the network is available, rather than in
// the suite, where a network call would make every run flaky.
//
// Prints the URL and whether it matched. Never prints the bundle. Exits non zero on a
// mismatch or on any failure to fetch, so a stale hash fails the build instead of the page.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src", "routes", "docs.ts"), "utf8");
const url = /const SCALAR_CDN = "([^"]+)"/.exec(source)?.[1];
const pinned = /const SCALAR_BUNDLE_INTEGRITY = "(sha384-[^"]+)"/.exec(source)?.[1];

if (!url || !pinned) {
  process.stderr.write("Could not read SCALAR_CDN and SCALAR_BUNDLE_INTEGRITY from src/routes/docs.ts.\n");
  process.exit(1);
}

process.stdout.write(`Reference bundle: ${url}\n`);

let bytes;
try {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    process.stderr.write(`The CDN answered ${res.status} ${res.statusText}.\n`);
    process.exit(1);
  }
  bytes = Buffer.from(await res.arrayBuffer());
} catch (err) {
  process.stderr.write(`The CDN could not be reached: ${err.message}\n`);
  process.exit(1);
}

const actual = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
if (actual !== pinned) {
  process.stderr.write(
    `Integrity mismatch. ${bytes.length} bytes served.\n  pinned:   ${pinned}\n  computed: ${actual}\n` +
    "Update SCALAR_BUNDLE_INTEGRITY in src/routes/docs.ts to the computed value, but only after\n" +
    "checking the pin still names the version you meant: the browser runs whatever this hash\n" +
    "accepts.\n");
  process.exit(1);
}

process.stdout.write(`Integrity matches the pinned hash. ${bytes.length} bytes, ${pinned}\n`);
