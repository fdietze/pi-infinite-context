import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("the npm package contains the extension and README resources, not development files", () => {
  // An isolated cache keeps this check from touching the user's npm cache.
  const cache = mkdtempSync(join(tmpdir(), "pi-package-cache-"));
  try {
    const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      encoding: "utf8",
      env: { ...process.env, NPM_CONFIG_CACHE: cache },
    }));
    const actual = pack.files.map((file: { path: string }) => file.path).sort();
    const source = readdirSync("extensions/infinite-context")
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "pi-test-fixtures.ts")
      .map((name) => `extensions/infinite-context/${name}`);
    assert.deepEqual(actual, ["package.json", "README.md", "LICENSE", "DESIGN.md", "docs/folding.svg", "docs/fold-payoff.png", "docs/publishing.md", ...source].sort());
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("repacking the same checkout produces identical tarball bytes for CI retries", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-package-retry-"));
  try {
    const pack = () => {
      const [result] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], {
        encoding: "utf8",
        env: { ...process.env, NPM_CONFIG_CACHE: join(temporary, "cache") },
      }));
      const bytes = readFileSync(join(temporary, result.filename));
      assert.equal(result.integrity, `sha512-${createHash("sha512").update(bytes).digest("base64")}`);
      return bytes;
    };
    assert.deepEqual(pack(), pack());
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
