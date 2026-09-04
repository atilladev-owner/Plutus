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
    const isDesignDoc = file.startsWith("docs/superpowers/");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const at = { file, line: i + 1, excerpt: line.trim().slice(0, 100) };
      if (!isLicence && DASHES.test(line)) violations.push({ rule: "no-dashes", ...at });
      if (!isLicence && EMOJI.test(line)) violations.push({ rule: "no-emoji", ...at });
      if (inSrc && CONSOLE.test(line)) violations.push({ rule: "no-console", ...at });
      if (inSrc && FLOAT.test(line)) violations.push({ rule: "no-float-money", ...at });
      if (inSrc && ANY.test(line)) violations.push({ rule: "no-any", ...at });
      if (!isEnvExample && !isDesignDoc && SECRETS.some((re) => re.test(line))) violations.push({ rule: "no-secrets", ...at });
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
