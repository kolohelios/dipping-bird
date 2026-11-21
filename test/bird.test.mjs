import assert from "node:assert/strict";
import test from "node:test";
import * as core from "../extensions/core.ts";
import { createState, deferIdentity, harness } from "./harness.mjs";

const work = { status: "continue", summary: "Next step", evidence: [] };
const input = (h, text, source = "interactive") =>
  h.handlers.get("input")({ source, text }, h.ctx);
const context = (h, prompt) =>
  h.handlers.get("before_agent_start")({ messageType: "user", prompt }, h.ctx);

test("loading and empty lifecycle are inert", async () => {
  const h = harness();
  for (const name of ["session_start", "session_compact", "session_shutdown"])
    await h.handlers.get(name)({}, h.ctx);
  await h.handlers.get("agent_settled")({ aborted: true }, h.ctx);
  await h.command("");
  await h.command("unknown");
  await h.command("stop");
  assert.equal(h.latest(), undefined);
  assert.equal(h.calls.length, 0);
  assert.equal(h.messages.length, 0);
  await assert.rejects(h.checkpoint(work));
});

test("start is explicit, pinned, read-only, and waits for its prompt", async () => {
  const h = harness();
  await h.rawCommand("start Goal");
  assert.equal(h.latest().mode, "paused");
  assert.equal(await h.settle(), undefined);
  assert.equal(h.calls[0][0], "jj");
  assert.equal(h.calls[0][1][0], "--ignore-working-copy");
  assert.equal(h.calls[0][2].timeout, 5000);
  await context(h, h.messages[0]);
  h.handlers.get("agent_start")({}, h.ctx);
  assert.equal(h.latest().mode, "running");
  assert.equal(h.latest().change, h.state.change);
  assert(h.messages[0].includes("authorizes no new I/O"));
  await h.command("start");
  assert.equal(h.messages.length, 1);
  assert.equal(
    h.tools.get("bird_checkpoint").parameters.additionalProperties,
    false,
  );
});

test("busy starts and failed identities cannot start work", async () => {
  const h = harness();
  h.state.idle = false;
  await h.command("start");
  h.state.idle = true;
  h.state.execFails = true;
  await h.command("start");
  assert.equal(h.messages.length, 0);
});

test("queued start is invalidated by stop or human input", async () => {
  for (const stop of [true, false]) {
    const h = harness();
    await h.rawCommand("start Goal");
    await input(h, h.messages[0], "extension");
    if (stop) await h.command("stop");
    else await input(h, "wait");
    await context(h, h.messages[0]);
    h.handlers.get("agent_start")({}, h.ctx);
    assert.equal(h.latest().mode, "paused");
    assert(h.state.aborts > 0);
  }
});

test("human input cancels a start during either identity lookup", async () => {
  for (const phase of ["start", "context", "settled"]) {
    const h = harness();
    if (phase !== "start") await h.rawCommand("start Goal");
    const finish = deferIdentity(h);
    const pending =
      phase === "start"
        ? h.rawCommand("start Goal")
        : context(h, h.messages[0]);
    if (phase === "settled")
      h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
    else await input(h, "wait");
    finish();
    await pending;
    h.handlers.get("agent_start")({}, h.ctx);
    if (h.latest()) assert.equal(h.latest().mode, "paused");
    else assert.equal(h.messages.length, 0);
  }
});

test("cancelled checkpoints cannot persist completion", async () => {
  const h = harness();
  await h.command("start");
  const finish = deferIdentity(h);
  const controller = new AbortController();
  const pending = h.checkpoint(
    { ...work, status: "complete", evidence: ["proof"] },
    controller.signal,
  );
  controller.abort();
  finish();
  await assert.rejects(pending, /cancelled/);
  assert.equal(h.latest().mode, "running");
  await assert.rejects(h.checkpoint(work, controller.signal), /cancelled/);
  h.handlers.get("agent_settled")({ aborted: true }, h.ctx);
  assert.equal(h.latest().mode, "paused");
});

test("pasted startup markers are ordinary user text", async () => {
  const h = harness();
  await context(
    h,
    "Explain this:\n[BIRD START 00000000-0000-0000-0000-000000000000]\nquoted transcript",
  );
  assert.equal(h.state.aborts, 0);
});

test("queued starts cannot arm outside their original time window", async (t) => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  for (const phase of ["context", "agent_start"]) {
    now = 100;
    const h = harness();
    await h.rawCommand("start");
    if (phase === "agent_start") await context(h, h.messages[0]);
    now += core.MAX_ELAPSED_MS;
    if (phase === "context") await context(h, h.messages[0]);
    h.handlers.get("agent_start")({}, h.ctx);
    assert.equal(h.latest().mode, "paused");
    assert.equal(h.state.aborts, 1);
  }
});

test("queue failure disarms", async () => {
  const h = harness();
  h.pi.sendUserMessage = () => {
    throw new Error("queue failure");
  };
  await h.command("start");
  assert.equal(h.latest().mode, "paused");
});

test("continuation is hidden and does not duplicate other work", async () => {
  const h = harness();
  await h.command("start");
  assert.equal((await context(h, "manual message")).message.display, false);
  h.state.pending = true;
  assert.equal(await h.settle(), undefined);
  h.state.pending = false;
  assert.equal(await h.settle("completed", true), undefined);
  const result = await h.settle();
  assert.equal(result.continue, true);
  assert.equal(h.latest().continuations, 1);
  assert.equal(result.entries[1].display, false);
});

test("terminal checkpoints stop until explicit resume with remaining limits", async () => {
  for (const status of ["blocked", "pause", "complete"]) {
    const h = harness();
    await h.command("start");
    await h.settle();
    const origin = h.latest();
    if (status === "complete")
      await assert.rejects(h.checkpoint({ ...work, status }));
    const result = await h.checkpoint({
      ...work,
      status,
      evidence: ["proof.txt"],
    });
    assert.equal(await h.settle(), undefined);
    await input(h, "more context");
    assert.notEqual(h.latest().mode, "running");
    await h.command("status");
    if (status === "complete")
      assert(result.content[0].text.includes("not independently certified"));
    await h.command("start");
    assert.equal(h.latest().startedAt, origin.startedAt);
    assert.equal(h.latest().continuations, origin.continuations);
  }
});

test("abort, errors, and explicit cancellation pause", async () => {
  for (const action of ["error", "aborted", "stop", "pause", "settled"]) {
    const h = harness();
    await h.command("start");
    if (["error", "aborted"].includes(action)) await h.settle(action);
    else if (action === "settled") {
      await h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
      await h.handlers.get("agent_settled")({ aborted: true }, h.ctx);
    } else await input(h, action);
    assert.equal(h.latest().mode, "paused");
    assert.equal(await h.settle(), undefined);
  }
});

test("identity drift is refused at each active boundary", async () => {
  for (const action of ["checkpoint", "context", "settle"]) {
    const h = harness();
    await h.command("start");
    h.state.change = "zzzzzzzz";
    if (action === "checkpoint") await assert.rejects(h.checkpoint(work));
    else if (action === "context")
      assert.equal(
        (await context(h, "manual")).message.customType,
        "bird-paused",
      );
    else await h.settle();
    assert.equal(h.latest().mode, "paused");
    await h.command("start");
    assert.equal(h.messages.length, 1);
  }
});

test("stop wins in-flight identity lookups", async () => {
  for (const action of ["start", "context", "checkpoint", "settle"]) {
    const h = harness();
    if (action !== "start") await h.command("start");
    const finish = deferIdentity(h);
    const pending =
      action === "start"
        ? h.command("start")
        : action === "context"
          ? context(h, "manual")
          : action === "checkpoint"
            ? h.checkpoint(work)
            : h.settle();
    await h.command("stop");
    finish();
    if (action === "checkpoint") await assert.rejects(pending);
    else assert.equal(await pending, undefined);
    if (h.latest()) assert.equal(h.latest().mode, "paused");
  }
});

test("caps cannot be reset by ordinary resume", async (t) => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  const h = harness();
  await h.command("start");
  for (let i = 0; i < core.MAX_CONTINUATIONS; i++)
    assert.equal((await h.settle()).continue, true);
  h.ctx.hasUI = false;
  await h.settle();
  await h.command("start");
  assert.equal(h.messages.length, 1);
  await h.command("start New window");
  assert.equal(h.latest().continuations, 0);
  now += core.MAX_ELAPSED_MS;
  await h.settle();
  await h.command("start");
  assert.equal(h.messages.length, 2);
});

test("compaction preserves state but restoration never arms", async () => {
  const h = harness();
  await h.command("start");
  await h.handlers.get("session_compact")({}, h.ctx);
  assert.equal(h.latest().mode, "running");
  await h.handlers.get("session_shutdown")({}, h.ctx);
  const next = harness(h.entries);
  await next.handlers.get("session_start")({}, next.ctx);
  assert.equal(next.latest().mode, "paused");
  await next.command("start");
  await next.handlers.get("session_tree")({}, next.ctx);
  assert.equal(next.latest().mode, "paused");
});

test("state inputs are bounded and normalized", () => {
  const state = createState();
  for (const raw of [
    null,
    {},
    { ...state, version: 2 },
    { ...state, mode: "bad" },
    { ...state, evidence: [42] },
    { ...state, continuations: 61 },
    { ...state, evidence: [""] },
    { ...state, startedAt: Infinity },
    { ...state, startedAt: -1 },
  ])
    assert.equal(core.restore(raw), undefined);
  for (const goal of ["", "x".repeat(4001)])
    assert.throws(() => core.start(goal, "/work", "abcdefgh", 0));
  for (const [summary, refs] of [
    ["", []],
    ["ok", [""]],
    ["ok", Array(33).fill("ref")],
  ])
    assert.throws(() => core.checkpoint(state, "continue", summary, refs));
  assert.equal(core.clean(" a\n\u001bb "), "a  b");
  assert.throws(() =>
    core.checkpoint({ ...state, mode: "paused" }, "continue", "work", []),
  );
  assert.equal(
    core.advance({ ...state, mode: "paused" }, 0, "completed", true).mode,
    "paused",
  );
  assert.equal(
    core.advance(state, state.startedAt - 1, "completed", true).mode,
    "paused",
  );
});
