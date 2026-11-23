import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  bumpVersion,
  createRelease,
  planBump,
  planRelease,
  prepareRelease,
  stampRelease,
} from "../scripts/release.mjs";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = parse(read(".github/workflows/publish.yml"));
const ci = parse(read(".github/workflows/ci.yml"));
const steps = workflow.jobs.publish.steps;
const sha = "a".repeat(40);
const olderSha = "b".repeat(40);
const repository = "kolohelios/dipping-bird";
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const metadata = (versions = { "0.1.0": {} }) => ({ name: pkg.name, versions });

test("main pushes and manual retries require full CI, with no App or npm token", () => {
  assert.deepEqual(workflow.on, {
    push: { branches: ["main"] },
    workflow_dispatch: null,
  });
  assert.equal(workflow.concurrency.group, "npm-publish");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert(Object.hasOwn(ci.on, "workflow_call"));
  assert.equal(workflow.jobs.validate.uses, "./.github/workflows/ci.yml");
  assert.equal(workflow.jobs.publish.needs, "validate");
  for (const job of Object.values(workflow.jobs))
    assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.equal(workflow.jobs.publish.environment, "npm");
  assert.equal(workflow.jobs.publish["runs-on"], "ubuntu-24.04");
  assert.deepEqual(workflow.jobs.publish.permissions, {
    contents: "write",
    "id-token": "write",
  });
  assert.equal(steps[0].with.ref, "${{ github.sha }}");
  assert.equal(steps[0].with["persist-credentials"], false);
  for (const step of steps.filter(({ uses }) => uses))
    assert.match(step.uses, /@[a-f0-9]{40}$/);
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /secrets\.|RELEASE_APP|NODE_AUTH_TOKEN|NPM_TOKEN/,
  );
});

test("publishing builds the stamped tarball, requests provenance, then creates the GitHub release", () => {
  const prepare = steps.findIndex(({ id }) => id === "release");
  const build = steps.findIndex(
    ({ name }) => name === "Assemble and verify release tarball",
  );
  const publish = steps.findIndex(
    ({ name }) =>
      name === "Publish verified tarball with npm trusted publishing",
  );
  const finalize = steps.findIndex(
    ({ name }) => name === "Create release tag and GitHub release",
  );
  assert(
    prepare >= 0 && prepare < build && build < publish && publish < finalize,
  );
  assert.match(steps[prepare].run, /node scripts\/release.mjs prepare$/);
  assert.match(steps[build].run, /just install\n/);
  assert.match(steps[build].run, /just build/);
  for (const step of [steps[build], steps[publish]])
    assert.equal(step.if, "steps.release.outputs.published != 'true'");
  assert.match(
    steps[publish].run,
    /npm publish "\.\/dist\/kolohelios-dipping-bird-\$\{RELEASE_VERSION\}\.tgz"/,
  );
  assert.match(
    steps[publish].run,
    /--access public --provenance --tag latest --registry=https:\/\/registry\.npmjs\.org/,
  );
  assert.equal(
    steps[publish].env.RELEASE_VERSION,
    "${{ steps.release.outputs.version }}",
  );
  assert.match(steps[finalize].run, /node scripts\/release.mjs finalize$/);
  assert.equal(steps[finalize].env.GH_TOKEN, "${{ github.token }}");
});

test("patch versions follow the greatest stable npm release, not a stale checkout or latest tag", () => {
  assert.deepEqual(planRelease(metadata(), "0.1.0", sha), {
    version: "0.1.1",
    published: false,
  });
  assert.equal(
    planRelease(
      metadata({ "0.1.2": {}, "0.1.10": {}, "0.2.0-beta.1": {} }),
      "0.1.0",
      sha,
    ).version,
    "0.1.11",
  );
  assert.equal(
    planRelease(metadata({ "0.9.9": {} }), "0.1.0", sha).version,
    "0.9.10",
  );
  assert.equal(planRelease(metadata(), "0.2.0", sha).version, "0.2.0");
  assert.deepEqual(
    planRelease(
      metadata({ "0.1.1": { "x-release-commit": sha }, "0.1.2": {} }),
      "0.1.0",
      sha,
    ),
    { version: "0.1.1", published: true },
  );
});

test("invalid metadata and unsafe versions fail closed", () => {
  assert.throws(() =>
    planRelease({ name: "other", versions: {} }, "0.1.0", sha),
  );
  assert.throws(() => planRelease(metadata({}), "0.1.0", sha));
  assert.throws(() => planRelease(metadata(), "1.0.0-beta.1", sha));
  assert.throws(() => planRelease(metadata(), "0.1.0", "not-a-sha"));
  assert.throws(() =>
    planRelease(metadata({ "0.1.9007199254740991": {} }), "0.1.0", sha),
  );
});

test("release stamping updates both manifests without changing dependencies or the inputs", () => {
  const stamped = stampRelease(pkg, lock, "0.1.123", sha);
  assert.equal(stamped.pkg.version, "0.1.123");
  assert.equal(stamped.pkg["x-release-commit"], sha);
  assert.equal(stamped.lock.version, "0.1.123");
  assert.equal(stamped.lock.packages[""].version, "0.1.123");
  assert.deepEqual(stamped.pkg.devDependencies, pkg.devDependencies);
  assert.deepEqual(
    stamped.lock.packages["node_modules/yaml"],
    lock.packages["node_modules/yaml"],
  );
  assert.equal(pkg.version, lock.version);
  assert.equal(pkg["x-release-commit"], undefined);
  assert.throws(() =>
    stampRelease(pkg, { ...lock, version: "0.0.0" }, "0.1.1", sha),
  );
});

async function fixture(run) {
  const cwd = process.cwd();
  const scratch = mkdtempSync(join(tmpdir(), "bird-release-"));
  try {
    process.chdir(scratch);
    writeFileSync("package.json", JSON.stringify({ ...pkg, version: "0.1.0" }));
    writeFileSync(
      "package-lock.json",
      JSON.stringify({
        ...lock,
        version: "0.1.0",
        packages: {
          ...lock.packages,
          "": { ...lock.packages[""], version: "0.1.0" },
        },
      }),
    );
    await run(join(scratch, "output"));
  } finally {
    process.chdir(cwd);
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("just bump plans minor, major, and exact versions against npm rather than the checkout", () => {
  const registry = metadata({ "0.1.9": {}, "0.3.7": {}, "1.0.0-beta.1": {} });
  assert.equal(planBump(registry, "0.1.0", "minor"), "0.4.0");
  assert.equal(planBump(registry, "0.1.0", "major"), "1.0.0");
  assert.equal(planBump(registry, "0.1.0", "0.5.0"), "0.5.0");
  assert.equal(planBump(registry, "0.4.0", "minor"), "0.4.0");
  assert.throws(() => planBump(registry, "0.1.0", "0.3.7"), /exceed/);
  assert.throws(() => planBump(registry, "0.1.0", "0.3.6"), /exceed/);
  assert.throws(() => planBump(registry, "1.0.0", "minor"), /lower/);
  for (const invalid of [
    "patch",
    "1.0.0-beta.1",
    "v1.0.0",
    "$(echo unsafe)",
    "01.0.0",
  ])
    assert.throws(() => planBump(registry, "0.1.0", invalid));
});

test("just bump updates both local manifests without a commit marker or publication", async () => {
  await fixture(async () => {
    let requests = 0;
    const version = await bumpVersion({
      target: "minor",
      api: async (url, options) => {
        requests++;
        assert.equal(
          url,
          "https://registry.npmjs.org/%40kolohelios%2Fdipping-bird",
        );
        assert.equal(options, undefined);
        return metadata({ "0.1.37": {} });
      },
    });
    assert.equal(version, "0.2.0");
    assert.equal(requests, 1);
    const updatedPkg = JSON.parse(readFileSync("package.json", "utf8"));
    const updatedLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    assert.equal(updatedPkg.version, "0.2.0");
    assert.equal(updatedLock.version, "0.2.0");
    assert.equal(updatedLock.packages[""].version, "0.2.0");
    assert.equal(updatedPkg["x-release-commit"], undefined);
    assert.deepEqual(updatedPkg.devDependencies, pkg.devDependencies);
  });
});

test("just bump leaves manifests untouched on invalid input, inconsistency, or registry failure", async () => {
  await fixture(async () => {
    const before = readFileSync("package.json", "utf8");
    const lockBefore = readFileSync("package-lock.json", "utf8");
    let requests = 0;
    const api = async () => {
      requests++;
      throw new Error("registry unavailable");
    };
    await assert.rejects(bumpVersion({ target: "patch", api }));
    assert.equal(requests, 0);
    await assert.rejects(
      bumpVersion({ target: "minor", api }),
      /registry unavailable/,
    );
    assert.equal(requests, 1);
    assert.equal(readFileSync("package.json", "utf8"), before);
    assert.equal(readFileSync("package-lock.json", "utf8"), lockBefore);
    writeFileSync(
      "package-lock.json",
      JSON.stringify({ ...lock, version: "0.0.0" }),
    );
    await assert.rejects(bumpVersion({ target: "major", api }));
    assert.equal(requests, 1);
    assert.equal(readFileSync("package.json", "utf8"), before);
  });
});

test("just exposes the bump helper without shell interpolation of its input", () => {
  assert.match(
    read("justfile"),
    /\[positional-arguments\]\nbump target:\n {4}node scripts\/release.mjs bump "\$1"/,
  );
});

test("prepare stamps a new descendant release and writes safe workflow outputs", async () => {
  await fixture(async (output) => {
    const calls = [];
    const plan = await prepareRelease({
      sha,
      repository,
      token: "test-token",
      output,
      api: async (url, options) => {
        calls.push({ url, options });
        if (url.startsWith("https://registry.npmjs.org/"))
          return metadata({ "0.1.1": { "x-release-commit": olderSha } });
        assert(url.endsWith(`/compare/${olderSha}...${sha}`));
        assert.equal(options.token, "test-token");
        return { status: "ahead" };
      },
    });
    assert.deepEqual(plan, { version: "0.1.2", published: false });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options, undefined);
    assert.equal(
      JSON.parse(readFileSync("package.json", "utf8"))["x-release-commit"],
      sha,
    );
    assert.equal(
      readFileSync(output, "utf8"),
      "version=0.1.2\npublished=false\n",
    );
  });
});

test("prepare recovers a successful publication without another bump or manifest edits", async () => {
  await fixture(async (output) => {
    const before = readFileSync("package.json", "utf8");
    await prepareRelease({
      sha,
      repository,
      output,
      api: async () =>
        metadata({
          "0.1.1": { "x-release-commit": sha },
          "0.1.2": { "x-release-commit": olderSha },
        }),
    });
    assert.equal(
      readFileSync(output, "utf8"),
      "version=0.1.1\npublished=true\n",
    );
    assert.equal(readFileSync("package.json", "utf8"), before);
  });
});

test("prepare refuses stale/divergent runs and registry failures without stamping", async () => {
  await fixture(async (output) => {
    for (const status of ["behind", "diverged", "identical"]) {
      await assert.rejects(
        prepareRelease({
          sha,
          repository,
          output,
          api: async (url) =>
            url.includes("registry.npmjs.org")
              ? metadata({ "0.1.1": { "x-release-commit": olderSha } })
              : { status },
        }),
        /newer or unrelated/,
      );
    }
    await assert.rejects(
      prepareRelease({
        sha,
        repository,
        output,
        api: async () => {
          throw new Error("registry unavailable");
        },
      }),
      /registry unavailable/,
    );
    assert.equal(
      JSON.parse(readFileSync("package.json", "utf8"))["x-release-commit"],
      undefined,
    );
  });
});

test("finalize confirms npm, creates a commit-pinned tag, and generates release notes", async () => {
  const calls = [];
  await createRelease({
    version: "0.1.1",
    sha,
    repository,
    token: "test-token",
    api: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("registry.npmjs.org"))
        return { "x-release-commit": sha };
      if (options.method === "POST") return {};
      return null;
    },
  });
  assert.equal(calls[0].options, undefined);
  const writes = calls.filter(({ options }) => options?.method === "POST");
  assert.deepEqual(
    writes.map(({ options }) => options.body),
    [
      { ref: "refs/tags/v0.1.1", sha },
      {
        tag_name: "v0.1.1",
        name: "v0.1.1",
        target_commitish: sha,
        generate_release_notes: true,
      },
    ],
  );
  assert(writes.every(({ options }) => options.token === "test-token"));
});

test("finalize retries existing tags/releases without rewriting them", async () => {
  const writes = [];
  await createRelease({
    version: "0.1.1",
    sha,
    repository,
    api: async (url, options) => {
      if (options?.method === "POST") writes.push(url);
      if (url.includes("registry.npmjs.org"))
        return { "x-release-commit": sha };
      if (url.includes("/commits/")) return { sha };
      return { id: 1 };
    },
  });
  assert.deepEqual(writes, []);
});

test("finalize completes a release after tag creation succeeded in a previous attempt", async () => {
  const writes = [];
  await createRelease({
    version: "0.1.1",
    sha,
    repository,
    api: async (url, options) => {
      if (url.includes("registry.npmjs.org"))
        return { "x-release-commit": sha };
      if (url.includes("/commits/")) return { sha };
      if (options?.method === "POST") {
        writes.push(url);
        return {};
      }
      if (url.includes("/releases/tags/")) return null;
      return { ref: "refs/tags/v0.1.1" };
    },
  });
  assert.deepEqual(writes, [
    `https://api.github.com/repos/${repository}/releases`,
  ]);
});

test("finalize refuses missing npm confirmation or a conflicting tag before release creation", async () => {
  const writes = [];
  for (const conflict of ["npm", "tag"]) {
    await assert.rejects(
      createRelease({
        version: "0.1.1",
        sha,
        repository,
        api: async (url, options) => {
          if (options?.method === "POST") writes.push(url);
          if (url.includes("registry.npmjs.org"))
            return { "x-release-commit": conflict === "npm" ? olderSha : sha };
          if (url.includes("/commits/")) return { sha: olderSha };
          return { id: 1 };
        },
      }),
    );
  }
  assert.deepEqual(writes, []);
});
