import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("npm build creates its output in a fresh package directory", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bird-cold-build-"));
  try {
    mkdirSync(join(scratch, "test"));
    // Reuse only the locked developer tools; the build output starts absent.
    symlinkSync(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(scratch, "node_modules"),
      "dir",
    );
    for (const path of [
      "package.json",
      "extensions",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "LICENSE-MIT",
      "LICENSE-APACHE",
      "architecture.md",
      "architecture-decision-record.md",
      "test/package.test.mjs",
    ])
      cpSync(new URL(`../${path}`, import.meta.url), join(scratch, path), {
        recursive: true,
      });
    execFileSync("npm", ["run", "build"], {
      cwd: scratch,
      // Invoke the standalone CLI, not a recursive Node test-runner child.
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name !== "NODE_TEST_CONTEXT",
        ),
      ),
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
