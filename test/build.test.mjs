import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
import { promisify } from "node:util";

const execute = promisify(execFile);

test("concurrent npm builds publish a complete artifact from a fresh directory", async () => {
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
    await Promise.all(
      [0, 1].map(() =>
        execute("npm", ["run", "build"], {
          cwd: scratch,
          // Invoke the standalone CLI, not a recursive Node test-runner child.
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => name !== "NODE_TEST_CONTEXT",
            ),
          ),
          encoding: "utf8",
          timeout: 120000,
        }),
      ),
    );
    assert.deepEqual(readdirSync(join(scratch, "dist")), [
      "kolohelios-dipping-bird-0.1.0.tgz",
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
