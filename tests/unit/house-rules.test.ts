import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTree, type Violation } from "../../scripts/check-house-rules.mjs";

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
    expect(checkTree(root).map((v: Violation) => v.rule)).toContain("no-console");
  });
  it("flags float arithmetic helpers in src", () => {
    const root = tree({ "src/a.ts": "const x = parseFloat('1');\nconst y = (2).toFixed(2);\n" });
    const rules = checkTree(root).map((v: Violation) => v.rule);
    expect(rules.filter((r: string) => r === "no-float-money")).toHaveLength(2);
  });
  it("flags any", () => {
    const root = tree({ "src/a.ts": "let x: any = 1; const y = x as any;\n" });
    expect(checkTree(root).map((v: Violation) => v.rule)).toContain("no-any");
  });
  it("flags a secret shaped string anywhere but the example env", () => {
    const root = tree({
      "src/a.ts": 'const t = "pl_' + 'live_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF' + '";\n',
      ".env.example": "X=pl_live_example\n",
    });
    const hits = checkTree(root).filter((v: Violation) => v.rule === "no-secrets");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.file).toBe("src/a.ts");
  });
  it("flags em dashes and emoji outside LICENSE.md", () => {
    const dashChar = String.fromCharCode(0x2014);
    const root = tree({
      "docs/x.md": "a " + dashChar + " b\n",
      "LICENSE.md": "a " + dashChar + " b\n",
      "src/b.ts": '// \u{1F600}\n',
    });
    const rules = checkTree(root).map((v: Violation) => `${v.rule}:${v.file}`);
    expect(rules).toContain("no-dashes:docs/x.md");
    expect(rules).toContain("no-emoji:src/b.ts");
    expect(rules).not.toContain("no-dashes:LICENSE.md");
  });
  it("fails loud when the lockfile is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "plutus-rules-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    expect(checkTree(root).map((v: Violation) => v.rule)).toContain("lockfile-present");
  });
  it("passes a clean tree", () => {
    const root = tree({ "src/a.ts": "export const a = 1n;\n" });
    expect(checkTree(root)).toEqual([]);
  });
  it("flags em dashes in design docs", () => {
    const dashChar = String.fromCharCode(0x2014);
    const root = tree({ "docs/superpowers/x.md": "a " + dashChar + " b\n" });
    expect(checkTree(root).map((v: Violation) => v.rule)).toContain("no-dashes");
  });
  it("exempts secrets in design docs", () => {
    const root = tree({ "docs/superpowers/x.md": 'const t = "pl_' + 'live_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF' + '";\n' });
    const hasSecretViolation = checkTree(root).some((v: Violation) => v.rule === "no-secrets");
    expect(hasSecretViolation).toBe(false);
  });
  it("exempts the one documented example secret named in README and the reference page", () => {
    const root = tree({
      "README.md": "Secret: pl_test_4f9a2c7e1b3d4a5f8e6c9b0a1d2e3f4a5b6c7d8e9f0a1b2c\n",
      "public/index.html": "<code>pl_test_4f9a2c7e1b3d4a5f8e6c9b0a1d2e3f4a5b6c7d8e9f0a1b2c</code>\n",
    });
    const hasSecretViolation = checkTree(root).some((v: Violation) => v.rule === "no-secrets");
    expect(hasSecretViolation).toBe(false);
  });
  it("still flags a real secret shaped string sharing a line with the documented example", () => {
    const root = tree({
      "README.md": "pl_test_4f9a2c7e1b3d4a5f8e6c9b0a1d2e3f4a5b6c7d8e9f0a1b2c " + "pl_" + "live_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF" + "\n",
    });
    const hits = checkTree(root).filter((v: Violation) => v.rule === "no-secrets");
    expect(hits).toHaveLength(1);
  });
});
