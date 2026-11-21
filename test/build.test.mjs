import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("npm build creates its output in a fresh package directory", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bird-cold-build-"));
  try {
    for (const path of [
      "package.json",
      "extensions",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "LICENSE-MIT",
      "LICENSE-APACHE",
    ])
      cpSync(new URL(`../${path}`, import.meta.url), join(scratch, path), {
        recursive: true,
      });
    execFileSync("npm", ["run", "build"], {
      cwd: scratch,
      stdio: "pipe",
      timeout: 120000,
    });
    assert.deepEqual(readdirSync(join(scratch, "dist")), [
      "kolohelios-dipping-bird-0.1.0.tgz",
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
