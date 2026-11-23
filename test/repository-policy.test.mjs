import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const read = (name) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const workflow = parse(read(".github/workflows/ci.yml"));
const ruleset = JSON.parse(read(".github/main-ruleset.json"));
const policySource = read(".shaka/repo.cue");
// Shaka supplies its packaged #RepoPolicy schema when it loads this file.
// Export the actual CUE values here; preflight validates against Shaka's schema.
const policy = JSON.parse(
  execFileSync("cue", ["export", "-"], {
    input: policySource.replace(
      "package repopolicy",
      "package repopolicy\n\n#RepoPolicy: _",
    ),
    encoding: "utf8",
    timeout: 10000,
  }),
);

const requiredChecks = [
  "Gate",
  "Validate (ubuntu-24.04, Node 24)",
  "Validate (ubuntu-24.04, Node 22)",
  "Validate (macos-15, Node 24)",
];

test("Shaka and the native ruleset require every explicitly named CI lane", () => {
  assert.equal(
    workflow.jobs.validate.name,
    "Validate (${{ matrix.os }}, Node ${{ matrix.node }})",
  );
  const matrix = workflow.jobs.validate.strategy.matrix.include;
  assert.deepEqual(
    [
      workflow.jobs.gate.name,
      ...matrix.map(({ os, node }) => `Validate (${os}, Node ${node})`),
    ],
    requiredChecks,
  );
  for (const lane of matrix)
    assert.equal(lane.shell, lane.node === 22 ? "node22" : "default");
  assert.deepEqual(policy.branchProtection.requiredChecks, requiredChecks);
  assert.equal(policy.branchProtection.strictStatusChecks, true);
  assert.equal(policy.branchProtection.allowForcePush, false);
  assert.equal(policy.branchProtection.allowDeletion, false);
  assert.deepEqual(policy.rulesets, {
    requireDeletion: true,
    requireNonFastForward: true,
    requireStatusChecks: true,
  });
  const checks = ruleset.rules.find(
    ({ type }) => type === "required_status_checks",
  );
  assert.deepEqual(
    checks.parameters.required_status_checks.map(({ context }) => context),
    requiredChecks,
  );
  assert.equal(checks.parameters.strict_required_status_checks_policy, true);
  assert.equal(checks.parameters.do_not_enforce_on_create, false);
});

test("main requires a PR, resolved conversations, and blocks force/deletion without bypasses", () => {
  assert.equal(ruleset.target, "branch");
  assert.equal(ruleset.enforcement, "active");
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.deepEqual(ruleset.conditions.ref_name, {
    include: ["refs/heads/main"],
    exclude: [],
  });
  assert(ruleset.rules.some(({ type }) => type === "deletion"));
  assert(ruleset.rules.some(({ type }) => type === "non_fast_forward"));
  const pr = ruleset.rules.find(({ type }) => type === "pull_request");
  assert.equal(pr.parameters.required_review_thread_resolution, true);
  assert.equal(pr.parameters.dismiss_stale_reviews_on_push, true);
  // A single maintainer cannot approve their own PR; requiring a PR is distinct.
  assert.equal(pr.parameters.required_approving_review_count, 0);
  assert.deepEqual(pr.parameters.allowed_merge_methods, ["rebase"]);
  assert.deepEqual(policy.merge, {
    rebase: true,
    merge: false,
    squash: false,
    deleteBranchOnMerge: true,
    autoMerge: false,
  });
});

test("CI reports required checks for every PR/main push and never accepts skipped lanes", () => {
  assert.deepEqual(policy.handAuthoredWorkflows, ["ci.yml", "publish.yml"]);
  assert(Object.hasOwn(workflow.on, "pull_request"));
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.on.pull_request?.paths, undefined);
  assert.equal(workflow.on.push.paths, undefined);
  assert.equal(workflow.jobs.validate.if, undefined);
  assert.equal(workflow.jobs.validate.strategy["fail-fast"], false);
  assert.equal(workflow.jobs.gate.needs, "validate");
  assert.equal(workflow.jobs.gate.if, "always()");
  const [gate] = workflow.jobs.gate.steps;
  assert.equal(gate.run, 'test "$RESULT" = success');
  assert.equal(gate.env.RESULT, "${{ needs.validate.result }}");
  assert(
    workflow.jobs.validate.steps.some(
      ({ run }) =>
        run === 'nix develop ".#${SHELL_NAME}" --command just validate',
    ),
  );
});
