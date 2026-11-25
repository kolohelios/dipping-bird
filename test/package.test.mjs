import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });

test("the release tarball installs offline and loads through Pi's real package loader", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "dipping-bird-package-"));
  try {
    const packedDir = join(scratch, "packed");
    mkdirSync(packedDir);
    writeFileSync(join(scratch, "npmrc"), "");
    writeFileSync(join(scratch, "global-npmrc"), "");
    const npmConfig = [
      "--offline",
      "--cache",
      join(scratch, "cache"),
      "--userconfig",
      join(scratch, "npmrc"),
      "--globalconfig",
      join(scratch, "global-npmrc"),
    ];
    const runNpm = (args, cwd) => run("npm", [...npmConfig, ...args], cwd);
    const [packed] = JSON.parse(
      runNpm(
        ["pack", "--ignore-scripts", "--json", "--pack-destination", packedDir],
        root,
      ),
    );
    const tarball = join(packedDir, packed.filename);
    assert.deepEqual(packed.files.map(({ path }) => path).sort(), [
      "CHANGELOG.md",
      "LICENSE",
      "LICENSE-APACHE",
      "LICENSE-MIT",
      "README.md",
      "architecture-decision-record.md",
      "architecture.md",
      "extensions/bird-control.ts",
      "extensions/core.ts",
      "extensions/index.ts",
      "extensions/nag-marker.ts",
      "extensions/nag-state.ts",
      "extensions/nag.ts",
      "package.json",
    ]);
    runNpm(
      [
        "install",
        tarball,
        "--offline",
        "--ignore-scripts",
        "--omit=dev",
        "--legacy-peer-deps",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
      ],
      scratch,
    );
    const installed = join(
      scratch,
      "node_modules",
      "@kolohelios",
      "dipping-bird",
    );
    const manifest = JSON.parse(
      readFileSync(join(installed, "package.json"), "utf8"),
    );
    const sourceManifest = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    assert.equal(manifest.version, sourceManifest.version);
    assert.equal(
      manifest["x-release-commit"],
      sourceManifest["x-release-commit"],
    );
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.license, "MIT OR Apache-2.0");
    // Canonical texts, with Jon Edwards's copyright notice; no clause edits.
    for (const [license, digest] of Object.entries({
      "LICENSE-MIT":
        "d6bc75555154175966fddf9a04976672a4ab6f906919c25b3bbd73d5ac0dbcd5",
      "LICENSE-APACHE":
        "9866ceb8d2eafefefcfb0b94486ee8d3a92b87bfbf21d76d3016c04535aef325",
    })) {
      const text = readFileSync(join(installed, license), "utf8");
      assert.equal(text, readFileSync(join(root, license), "utf8"));
      assert.equal(
        createHash("sha256").update(text.trim()).digest("hex"),
        digest,
      );
    }
    assert(manifest.keywords.includes("pi-package"));
    assert.deepEqual(manifest.pi.extensions, ["./extensions/index.ts"]);
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
    assert.deepEqual(manifest.peerDependencies, {
      "@earendil-works/pi-coding-agent": "*",
      typebox: "*",
    });
    assert.equal(existsSync(join(scratch, "node_modules", "typebox")), false);
    assert.equal(
      existsSync(
        join(scratch, "node_modules", "@earendil-works", "pi-coding-agent"),
      ),
      false,
    );
    for (const { path } of packed.files) {
      assert(
        !/\/nix\/store\/|\/Users\/|DATAOP-\d+|Precisely|whitepages/i.test(
          readFileSync(join(installed, path), "utf8"),
        ),
        `Private content in ${path}`,
      );
    }

    const loader = new DefaultResourceLoader({
      cwd: scratch,
      agentDir: join(scratch, "agent"),
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [installed],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.warnings ?? [], []);
    assert.equal(loaded.extensions.length, 1);
    const [extension] = loaded.extensions;
    assert(extension.commands.has("bird"));
    assert(extension.commands.has("nag"));
    assert(extension.tools.has("bird"));
    assert(extension.tools.has("nag"));
    assert.equal(
      extension.tools.get("bird_checkpoint").definition.exposure,
      "model-only",
    );
    for (const name of [
      "agent_start",
      "before_agent_start",
      "agent_before_settle",
      "agent_settled",
      "session_start",
      "session_tree",
      "session_shutdown",
      "session_compact",
      "input",
    ]) {
      assert(extension.handlers.has(name), `Missing ${name}`);
    }
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    const staged = join(dist, `.${packed.filename}.${randomUUID()}.tmp`);
    try {
      copyFileSync(tarball, staged);
      renameSync(staged, join(dist, packed.filename));
    } finally {
      rmSync(staged, { force: true });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
