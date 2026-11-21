import assert from "node:assert/strict";
import test from "node:test";
import * as core from "../extensions/core.ts";
import { createState } from "./harness.mjs";

for (const [field, values] of Object.entries({
  version: [undefined, 0, 2, "1"],
  mode: [undefined, null, "complete", ""],
  goal: [undefined, null, 42, "", " \n ", "x".repeat(4001)],
  cwd: [undefined, null, 42, ""],
  change: [undefined, null, "", "abc", "ABCDEFGH", "abcdefgh9"],
  startedAt: [undefined, null, "1", -1, NaN, Infinity],
  continuations: [undefined, null, "1", -1, 0.5, 61, NaN, Infinity],
  summary: [undefined, null, 42, "x".repeat(2001)],
  evidence: [
    undefined,
    null,
    "ref",
    [null],
    [42],
    [""],
    ["\n"],
    ["x".repeat(1001)],
    Array(33).fill("ref"),
  ],
})) {
  test(`restore rejects malformed ${field}`, () => {
    const sample = createState();
    for (const value of values) {
      assert.equal(core.restore({ ...sample, [field]: value }), undefined);
    }
    assert.equal(
      core.restore(
        Object.fromEntries(
          Object.entries(sample).filter(([key]) => key !== field),
        ),
      ),
      undefined,
    );
  });
}

test("restore always pauses every valid persisted mode without resetting limits", () => {
  const sample = {
    ...createState(),
    goal: "  goal\n ",
    summary: "last",
    continuations: 17,
    evidence: [" proof\n "],
  };
  for (const mode of ["running", "blocked", "paused", "review"]) {
    const restored = core.restore({ ...sample, mode });
    assert.equal(restored.mode, "paused");
    assert.equal(restored.goal, "goal");
    assert.equal(restored.continuations, 17);
    assert.equal(restored.startedAt, sample.startedAt);
    assert.deepEqual(restored.evidence, ["proof"]);
  }
  for (const raw of [false, 42, "state", [], null])
    assert.equal(core.restore(raw), undefined);
});

test("start validates every pin and time boundary", () => {
  for (const [cwd, change, now] of [
    ["", "abcdefgh", 0],
    ["/work", "abc", 0],
    ["/work", "ABCDEFGH", 0],
    ["/work", "abcdefgh", -1],
    ["/work", "abcdefgh", NaN],
    ["/work", "abcdefgh", Infinity],
  ])
    assert.throws(() => core.start("goal", cwd, change, now));
  const state = core.start(" x".repeat(2000).trim(), "/work", "abcdefgh", 0);
  assert.equal(state.goal.length, 3999);
  assert.equal(state.startedAt, 0);
});

test("checkpoint bounds are inclusive, normalized, and leave the input immutable", () => {
  const state = Object.freeze(createState());
  const refs = Object.freeze(Array(32).fill("x".repeat(1000)));
  const next = core.checkpoint(state, "continue", "x".repeat(2000), refs);
  assert.equal(next.mode, "running");
  assert.notEqual(next, state);
  assert.notEqual(next.evidence, refs);
  assert.equal(state.summary, "Started explicitly by the user.");
  for (const [summary, evidence] of [
    ["x".repeat(2001), []],
    ["ok", ["x".repeat(1001)]],
    ["\u007f", []],
    ["ok", ["\u001b"]],
  ])
    assert.throws(() => core.checkpoint(state, "continue", summary, evidence));
  for (const mode of ["paused", "blocked", "review"]) {
    assert.throws(() =>
      core.checkpoint({ ...state, mode }, "continue", "work", []),
    );
    assert.equal(
      core.advance({ ...state, mode }, 0, "completed", true).mode,
      mode,
    );
  }
});

test("invalid clocks cannot extend a supervision window", () => {
  const state = createState();
  for (const now of [NaN, Infinity, -Infinity]) {
    assert.equal(core.hasBudget(state, now), false);
    assert.equal(core.advance(state, now, "completed", true).mode, "paused");
  }
});

test("advance allows the final legal boundary but not a new supervision window", () => {
  const state = {
    ...core.start("goal", "/work", "abcdefgh", 100),
    continuations: 59,
  };
  const last = core.advance(
    state,
    100 + core.MAX_ELAPSED_MS - 1,
    "completed",
    true,
  );
  assert.equal(last.mode, "running");
  assert.equal(last.continuations, 60);
  assert.equal(last.startedAt, 100);
  assert.equal(core.advance(last, 101, "completed", true).mode, "paused");
  assert.equal(
    core.advance(state, 100 + core.MAX_ELAPSED_MS, "completed", true).mode,
    "paused",
  );
  assert.equal(core.advance(state, 99, "completed", true).mode, "paused");
});
