import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const name = "@kolohelios/dipping-bird";
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[a-f0-9]{40}$/;
const registry = "https://registry.npmjs.org";

function parts(version) {
  assert.match(version, stable, "Expected a stable package version");
  const values = version.split(".").map(Number);
  assert(values.every(Number.isSafeInteger), "Version component is too large");
  return values;
}

function compare(left, right) {
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function publishedVersions(metadata) {
  assert.equal(metadata.name, name);
  const versions = Object.keys(metadata.versions ?? {})
    .filter((version) => stable.test(version))
    .sort(compare);
  assert(versions.length > 0, "Expected an existing stable npm release");
  return versions;
}

export function planBump(metadata, sourceVersion, target) {
  parts(sourceVersion);
  const latest = publishedVersions(metadata).at(-1);
  const [major, minor] = parts(latest);
  const version =
    target === "major"
      ? `${major + 1}.0.0`
      : target === "minor"
        ? `${major}.${minor + 1}.0`
        : target;
  parts(version);
  assert(
    compare(version, latest) > 0,
    "Version must exceed every published stable version",
  );
  assert(
    compare(version, sourceVersion) >= 0,
    "Refusing to lower the pending source version",
  );
  return version;
}

// npm's immutable version metadata is the release ledger. A commit marker makes
// retries recover the original version, even if npm succeeded before CI failed.
export function planRelease(metadata, sourceVersion, sha) {
  assert.match(sha, shaPattern);
  parts(sourceVersion);
  const versions = publishedVersions(metadata);
  const previous = versions.find(
    (version) => metadata.versions[version]["x-release-commit"] === sha,
  );
  if (previous) return { version: previous, published: true };
  const latest = versions.at(-1);
  if (compare(sourceVersion, latest) > 0)
    return { version: sourceVersion, published: false };
  const [major, minor, patch] = parts(latest);
  assert(Number.isSafeInteger(patch + 1), "Patch version overflow");
  return { version: `${major}.${minor}.${patch + 1}`, published: false };
}

function updateVersion(pkg, lock, version) {
  parts(version);
  assert.equal(pkg.name, name);
  assert.equal(lock.name, name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  return {
    pkg: { ...pkg, version },
    lock: {
      ...lock,
      version,
      packages: {
        ...lock.packages,
        "": { ...lock.packages[""], version },
      },
    },
  };
}

export function stampRelease(pkg, lock, version, sha) {
  assert.match(sha, shaPattern);
  const stamped = updateVersion(pkg, lock, version);
  stamped.pkg["x-release-commit"] = sha;
  return stamped;
}

function writeManifests({ pkg, lock }) {
  writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
}

export async function bumpVersion({ target, api = request }) {
  // Reject malformed targets and inconsistent manifests before any network I/O.
  if (target !== "minor" && target !== "major") parts(target);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  updateVersion(pkg, lock, pkg.version);
  const metadata = await api(`${registry}/${encodeURIComponent(name)}`);
  const version = planBump(metadata, pkg.version, target);
  const updated = updateVersion(pkg, lock, version);
  delete updated.pkg["x-release-commit"];
  writeManifests(updated);
  return version;
}

async function request(
  url,
  { token, method = "GET", body, allow404 = false } = {},
) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  if (allow404 && response.status === 404) return null;
  assert(
    response.ok,
    `Release API request failed with HTTP ${response.status}`,
  );
  return response.json();
}

export async function prepareRelease({
  sha,
  repository,
  token,
  output,
  api = request,
}) {
  assert.match(sha, shaPattern);
  assert.equal(repository, "kolohelios/dipping-bird");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const metadata = await api(`${registry}/${encodeURIComponent(name)}`);
  const plan = planRelease(metadata, pkg.version, sha);
  // GitHub concurrency does not promise FIFO ordering. Refuse an old run that
  // would publish after a newer commit, but still allow completing its own tag.
  if (!plan.published) {
    const latest = publishedVersions(metadata).at(-1);
    const latestSha = metadata.versions[latest]["x-release-commit"];
    if (latestSha) {
      assert.match(latestSha, shaPattern);
      const comparison = await api(
        `https://api.github.com/repos/${repository}/compare/${latestSha}...${sha}`,
        { token },
      );
      assert.equal(
        comparison.status,
        "ahead",
        "A newer or unrelated commit is already released",
      );
    }
  }
  const stamped = stampRelease(pkg, lock, plan.version, sha);
  if (!plan.published) writeManifests(stamped);
  appendFileSync(
    output,
    `version=${plan.version}\npublished=${plan.published}\n`,
  );
  return plan;
}

export async function createRelease({
  version,
  sha,
  repository,
  token,
  api = request,
}) {
  parts(version);
  assert.match(sha, shaPattern);
  assert.equal(repository, "kolohelios/dipping-bird");
  // Do not create a success-looking GitHub release until npm confirms the exact
  // version and source marker. This also supports retrying after npm succeeded.
  const published = await api(
    `${registry}/${encodeURIComponent(name)}/${version}`,
  );
  assert.equal(published["x-release-commit"], sha);
  const root = `https://api.github.com/repos/${repository}`;
  const tag = `v${version}`;
  const existingTag = await api(`${root}/git/ref/tags/${tag}`, {
    token,
    allow404: true,
  });
  if (existingTag) {
    const commit = await api(`${root}/commits/${tag}`, { token });
    assert.equal(commit.sha, sha, "Release tag points to another commit");
  } else {
    await api(`${root}/git/refs`, {
      token,
      method: "POST",
      body: { ref: `refs/tags/${tag}`, sha },
    });
  }
  const existingRelease = await api(`${root}/releases/tags/${tag}`, {
    token,
    allow404: true,
  });
  if (!existingRelease) {
    await api(`${root}/releases`, {
      token,
      method: "POST",
      body: {
        tag_name: tag,
        name: tag,
        target_commitish: sha,
        generate_release_notes: true,
      },
    });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const options = {
    sha: process.env.GITHUB_SHA,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN,
    output: process.env.GITHUB_OUTPUT,
    version: process.env.RELEASE_VERSION,
  };
  if (process.argv[2] === "prepare") await prepareRelease(options);
  else if (process.argv[2] === "finalize") await createRelease(options);
  else if (process.argv[2] === "bump") {
    const version = await bumpVersion({ target: process.argv[3] });
    console.log(
      `Prepared ${version} in package.json and package-lock.json. Review and merge through a PR; nothing was published.`,
    );
  } else throw new Error("Expected prepare, finalize, or bump");
}
