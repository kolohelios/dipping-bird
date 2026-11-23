import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const root = new URL("..", import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
);

test("typecheck explicitly invokes the pinned TypeScript 7 compiler alias", () => {
  assert.equal(
    manifest.scripts.typecheck,
    "node node_modules/typescript-compiler/bin/tsc --noEmit",
  );
  const compiler = JSON.parse(
    readFileSync(
      new URL("node_modules/typescript-compiler/package.json", root),
      "utf8",
    ),
  );
  assert.equal(compiler.name, "typescript");
  assert.match(compiler.version, /^7\./);
  assert.equal(
    manifest.devDependencies["typescript-compiler"],
    `npm:typescript@${compiler.version}`,
  );
  assert.equal(
    execFileSync(
      process.execPath,
      ["node_modules/typescript-compiler/bin/tsc", "--version"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30000,
      },
    ).trim(),
    `Version ${compiler.version}`,
  );
});

test("ESLint's parser resolves the supported TypeScript 6 JavaScript API", () => {
  const require = createRequire(new URL("package.json", root));
  const eslintRequire = createRequire(require.resolve("typescript-eslint"));
  const parserRequire = createRequire(
    eslintRequire.resolve("@typescript-eslint/parser"),
  );
  const typescript = parserRequire("typescript");
  assert.equal(typescript.version, manifest.devDependencies.typescript);
  assert.match(typescript.version, /^6\./);
  assert.equal(typeof typescript.createSourceFile, "function");
  assert.equal(
    parserRequire.resolve("typescript"),
    require.resolve("typescript"),
  );
  const parser = eslintRequire("@typescript-eslint/parser");
  assert.equal(
    parser.parse("const n: number = 1;", { sourceType: "module" }).type,
    "Program",
  );
});
