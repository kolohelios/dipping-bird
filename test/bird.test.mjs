import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import * as core from "../extensions/core.ts";
import factory from "../extensions/index.ts";

export function harness(branch = []) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [...branch];
  const notifications = [];
  const messages = [];
  const calls = [];
  const state = {
    change: "ovqmlnlt",
    idle: true,
    pending: false,
    aborts: 0,
    execFails: false,
  };
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setStatus() {}, notify: (...args) => notifications.push(args) },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => {
        throw new Error("Do not use abandoned branches");
      },
    },
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    abort: () => {
      state.aborts++;
    },
  };
  const pi = {
    on: (name, handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    appendEntry: (customType, data) =>
      entries.push({ type: "custom", customType, data }),
    sendUserMessage: (message) => messages.push(message),
    exec: async (...args) => {
      calls.push(args);
      return {
        code: state.execFails ? 1 : 0,
        killed: false,
        stdout: state.change,
        stderr: "",
      };
    },
  };
  factory(pi);
  return {
    pi,
    ctx,
    state,
    entries,
    notifications,
    messages,
    calls,
    handlers,
    commands,
    tools,
    rawCommand: (args) => commands.get("bird").handler(args, ctx),
    async command(args) {
      const before = messages.length;
      await commands.get("bird").handler(args, ctx);
      if (messages.length === before) return;
      await handlers.get("before_agent_start")(
        { messageType: "user", prompt: messages.at(-1) },
        ctx,
      );
      handlers.get("agent_start")({}, ctx);
    },
    checkpoint: (params) =>
      tools
        .get("bird_checkpoint")
        .execute("test", params, undefined, undefined, ctx),
    latest: () =>
      entries.findLast(
        (entry) =>
          entry.type === "custom" && entry.customType === core.STATE_KEY,
      )?.data,
    async settle(outcome = "completed", continued = false) {
      const result = await handlers.get("agent_before_settle")(
        { outcome, continue: continued, entries: [] },
        ctx,
      );
      if (result?.entries) entries.push(...result.entries);
      return result;
    },
  };
}

const createState = () =>
  core.start(
    "Complete acceptance with native evidence",
    realpathSync(process.cwd()),
    "ovqmlnlt",
    Date.now(),
  );

test("empty lifecycle and status do not start Bird", async () => {
  const h = harness();
  await h.handlers.get("session_start")({}, h.ctx);
  await h.handlers.get("session_compact")({}, h.ctx);
  await h.handlers.get("session_shutdown")({}, h.ctx);
  await h.handlers.get("agent_settled")({ aborted: true }, h.ctx);
  await h.command("");
  await h.command("stop");
  assert.equal(h.latest(), undefined);
  assert.equal(h.messages.length, 0);
});

test("queued starts wait for the exact initial prompt and cannot arm after stop", async () => {
  const h = harness();
  await h.rawCommand("start Goal");
  const initial = h.messages[0];
  assert.equal(h.latest().mode, "paused");
  assert.equal(await h.settle(), undefined);
  await h.command("stop");
  await h.handlers.get("before_agent_start")(
    { messageType: "user", prompt: initial },
    h.ctx,
  );
  await h.handlers.get("agent_start")({}, h.ctx);
  assert.equal(h.state.aborts, 2);
  assert.equal(h.latest().mode, "paused");
});

test("human input cancels a queued initial start", async () => {
  const h = harness();
  await h.rawCommand("start Goal");
  await h.handlers.get("input")({ source: "interactive", text: "Wait" }, h.ctx);
  await h.handlers.get("agent_start")({}, h.ctx);
  assert.equal(h.latest().mode, "paused");
});

test("checkpoint identity drift and a changed resume pin are refused", async () => {
  const h = harness();
  await h.command("start Goal");
  h.state.change = "zzzzzzzz";
  await assert.rejects(
    h.checkpoint({ status: "continue", summary: "Work", evidence: [] }),
  );
  assert.equal(h.latest().mode, "paused");
  await h.command("start");
  assert.equal(h.messages.length, 1);
  assert.equal(h.latest().mode, "paused");
});

test("final abort pauses an active Bird, but normal settlement does not", async () => {
  const h = harness();
  await h.command("start Goal");
  await h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
  assert.equal(h.latest().mode, "running");
  await h.handlers.get("agent_settled")({ aborted: true }, h.ctx);
  assert.equal(h.latest().mode, "paused");
  await h.command("start");
  h.ctx.hasUI = false;
  const result = await h.settle("error");
  assert.equal(result.continue, undefined);
  assert.equal(h.latest().mode, "paused");
});

test("loading is inert; command explicitly starts with one user message and only read-only jj metadata", async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  assert.equal(h.messages.length, 0);
  assert.equal(
    h.tools.get("bird_checkpoint").parameters.additionalProperties,
    false,
  );
  await h.command("start");
  assert.equal(h.latest().mode, "running");
  assert.equal(h.latest().change, "ovqmlnlt");
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.calls[0].slice(0, 2), [
    "jj",
    [
      "--ignore-working-copy",
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      "change_id.short(8)",
    ],
  ]);
  assert(h.messages[0].includes("authorizes no new I/O"));
  assert(h.messages[0].includes("not certification by Bird"));
});

test("final boundary persists a hidden continuation and increments only the model-work counter", async () => {
  const h = harness();
  await h.command("start");
  const result = await h.settle();
  assert.equal(result.continue, true);
  assert.equal(h.latest().continuations, 1);
  assert.equal(result.entries[1].display, false);
  assert(result.entries[1].content.includes("Never invent approvals"));
  assert.equal(h.messages.length, 1);
});

test("blocked checkpoint stays stopped until explicit resume, preserving limits", async () => {
  const h = harness();
  await h.command("start");
  await h.settle();
  const before = h.latest();
  await h.checkpoint({
    status: "blocked",
    summary: "Need one explicit read-only scope",
    evidence: [],
  });
  assert.equal(await h.settle(), undefined);
  assert.equal(await h.settle(), undefined);
  await h.handlers.get("input")(
    { source: "extension", text: "Continue" },
    h.ctx,
  );
  assert.equal(h.latest().mode, "blocked");
  await h.handlers.get("input")(
    { source: "interactive", text: "Here is my decision" },
    h.ctx,
  );
  assert.equal(h.latest().mode, "blocked");
  assert.equal(await h.settle(), undefined);
  await h.command("start");
  assert.equal(h.latest().mode, "running");
  assert.equal(h.latest().startedAt, before.startedAt);
  assert.equal(h.latest().continuations, before.continuations);
  assert(h.latest().summary.includes("no permissions renewed"));
});

test("complete requires evidence and reports review rather than independent certification", async () => {
  const h = harness();
  await h.command("start");
  await assert.rejects(
    h.checkpoint({ status: "complete", summary: "Done", evidence: [] }),
  );
  const result = await h.checkpoint({
    status: "complete",
    summary: "Criteria have referenced evidence",
    evidence: ["safe-proof.json: every criterion"],
  });
  assert.equal(h.latest().mode, "review");
  assert(result.content[0].text.includes("not independently certified"));
  assert.equal(await h.settle(), undefined);
  await h.command("status");
  assert(h.notifications.at(-1)[0].includes("not independently certified"));
});

for (const outcome of ["aborted", "error"])
  test(`${outcome} pauses instead of restarting`, async () => {
    const h = harness();
    await h.command("start");
    const result = await h.settle(outcome);
    assert.equal(result.continue, undefined);
    assert.equal(h.latest().mode, "paused");
    assert.equal(h.latest().continuations, 0);
  });

test("stop aborts active work and ordinary user input does not reactivate a stopped loop", async () => {
  const h = harness();
  await h.command("start");
  h.state.idle = false;
  await h.command("stop");
  assert.equal(h.state.aborts, 1);
  await h.handlers.get("input")(
    { source: "interactive", text: "more context" },
    h.ctx,
  );
  assert.equal(h.latest().mode, "paused");
  assert.equal(await h.settle(), undefined);
});

test("user cancellation checkpoint remains paused on later ordinary input", async () => {
  const h = harness();
  await h.command("start");
  await h.checkpoint({
    status: "pause",
    summary: "User asked to stop",
    evidence: [],
  });
  await h.handlers.get("input")(
    { source: "interactive", text: "thanks" },
    h.ctx,
  );
  assert.equal(h.latest().mode, "paused");
  assert.equal(await h.settle(), undefined);
});

test("plain stop/pause input pauses, busy start and duplicate start cannot queue another run", async () => {
  const h = harness();
  h.state.idle = false;
  await h.command("start");
  assert.equal(h.messages.length, 0);
  h.state.idle = true;
  await h.command("start");
  await h.command("start");
  assert.equal(h.messages.length, 1);
  await h.handlers.get("input")({ source: "rpc", text: "pause" }, h.ctx);
  assert.equal(h.latest().mode, "paused");
});

test("jj identity failure and changed workspace or change pause, never switch VCS state", async () => {
  for (const fault of ["change", "cwd", "exec"]) {
    const h = harness();
    await h.command("start");
    if (fault === "change") h.state.change = "zzzzzzzz";
    if (fault === "cwd") h.ctx.cwd = tmpdir();
    if (fault === "exec") h.state.execFails = true;
    const result = await h.settle();
    assert.equal(result.continue, undefined);
    assert.equal(h.latest().mode, "paused");
    await assert.rejects(
      h.checkpoint({
        status: "continue",
        summary: "ignore drift",
        evidence: [],
      }),
    );
    assert(h.calls.every(([program]) => program === "jj"));
  }
});

test("before-agent context enforces pin warning without new permissions", async () => {
  const h = harness();
  await h.command("start");
  const context = await h.handlers.get("before_agent_start")({}, h.ctx);
  assert.equal(context.message.display, false);
  h.state.change = "zzzzzzzz";
  const warning = await h.handlers.get("before_agent_start")({}, h.ctx);
  assert.equal(warning.message.customType, "bird-paused");
  assert.equal(h.latest().mode, "paused");
});

test("pending user messages or another extension continuation do not generate duplicate Bird turns", async () => {
  const h = harness();
  await h.command("start");
  h.state.pending = true;
  assert.equal(await h.settle(), undefined);
  h.state.pending = false;
  assert.equal(await h.settle("completed", true), undefined);
  assert.equal(h.latest().continuations, 0);
});

test("60-continuation cap stops without done and ordinary resume does not reset it", async () => {
  const h = harness();
  await h.command("start");
  for (let i = 0; i < core.MAX_CONTINUATIONS; i++)
    assert.equal((await h.settle()).continue, true);
  assert.equal((await h.settle()).continue, undefined);
  assert.equal(h.latest().mode, "paused");
  assert.equal(h.latest().continuations, 60);
  const count = h.messages.length;
  await h.command("start");
  assert.equal(h.messages.length, count);
});

test("elapsed cap stops integrated continuation and explicit no-goal resume keeps the cap", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const h = harness();
  await h.command("start");
  now += core.MAX_ELAPSED_MS;
  assert.equal((await h.settle()).continue, undefined);
  assert.equal(h.latest().mode, "paused");
  const messages = h.messages.length;
  await h.command("start");
  assert.equal(h.messages.length, messages);
});

test("stop during identity lookup cannot enqueue another continuation", async () => {
  const h = harness();
  await h.command("start");
  let finish;
  h.pi.exec = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = h.settle();
  await h.command("stop");
  finish({ code: 0, killed: false, stdout: "ovqmlnlt", stderr: "" });
  assert.equal((await pending)?.continue, undefined);
  assert.equal(h.latest().mode, "paused");
});

test("stop cancels pending initial start, context injection and checkpoint without resurrecting the loop", async () => {
  for (const action of ["start", "context", "checkpoint"]) {
    const h = harness();
    if (action !== "start") await h.command("start");
    let finish;
    h.pi.exec = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending =
      action === "start"
        ? h.command("start")
        : action === "context"
          ? h.handlers.get("before_agent_start")({}, h.ctx)
          : h.checkpoint({ status: "continue", summary: "work", evidence: [] });
    const messages = h.messages.length;
    await h.command("stop");
    finish({ code: 0, killed: false, stdout: "ovqmlnlt", stderr: "" });
    if (action === "checkpoint") await assert.rejects(pending);
    else assert.equal(await pending, undefined);
    assert.equal(h.messages.length, messages);
    if (h.latest()) assert.equal(h.latest().mode, "paused");
  }
});

test("failure to queue the initial prompt disarms rather than leaving a running loop", async () => {
  const h = harness();
  h.pi.sendUserMessage = () => {
    throw new Error("simulated queue failure");
  };
  await h.command("start");
  assert.equal(h.latest().mode, "paused");
  assert.equal(await h.settle(), undefined);
});

test("elapsed cap and clock rollback stop at a boundary without authorizing resets", () => {
  const state = core.start("Goal", "/synthetic", "ovqmlnlt", 100);
  for (const now of [99, 100 + core.MAX_ELAPSED_MS]) {
    assert.equal(core.advance(state, now, "completed", true).mode, "paused");
  }
});

test("compaction preserves active state; reload/resume/tree restore only active-branch state and remain paused", async () => {
  const h = harness();
  await h.command("start");
  await h.settle();
  await h.handlers.get("session_compact")({}, h.ctx);
  assert.equal(h.latest().mode, "running");
  const restored = harness(h.entries);
  await restored.handlers.get("session_start")(
    { reason: "reload" },
    restored.ctx,
  );
  assert.equal(restored.latest().mode, "paused");
  assert.equal(restored.latest().continuations, 1);
  assert.equal(restored.messages.length, 0);
  await restored.command("start");
  assert.equal(restored.latest().continuations, 1);
  await restored.handlers.get("session_tree")({}, restored.ctx);
  assert.equal(restored.latest().mode, "paused");
  await restored.command("start");
  await restored.handlers.get("session_shutdown")({}, restored.ctx);
  assert.equal(restored.latest().mode, "paused");
});

test("malformed persistence never enables continuation, unknown commands and failed identity never start", async () => {
  const sample = createState();
  for (const invalid of [
    null,
    {},
    { ...sample, version: 2 },
    { ...sample, mode: "done" },
    { ...sample, change: "bad" },
    { ...sample, evidence: [42] },
    { ...sample, startedAt: Infinity },
    { ...sample, continuations: 61 },
  ]) {
    assert.equal(core.restore(invalid), undefined);
  }
  const h = harness();
  await h.command("unknown");
  await h.command("status");
  h.state.execFails = true;
  await h.command("start");
  assert.equal(h.messages.length, 0);
  await assert.rejects(
    h.checkpoint({ status: "continue", summary: "go", evidence: [] }),
  );
});

test("checkpoint bounds, control sanitization and new explicit goal retain boundaries", async () => {
  assert.equal(core.clean(" a\u001b\u0000\nb "), "a   b");
  for (const goal of ["", " ", "x".repeat(4001)])
    assert.throws(() => core.start(goal, "/synthetic", "ovqmlnlt", 1));
  const s = createState();
  for (const [summary, refs] of [
    ["", []],
    ["ok", [""]],
    ["ok", Array(33).fill("ref")],
  ]) {
    assert.throws(() => core.checkpoint(s, "continue", summary, refs));
  }
  const h = harness();
  await h.command("start");
  await h.command("stop");
  await h.command("start Complete a fresh explicitly scoped goal");
  assert.equal(h.latest().continuations, 0);
  assert(h.messages.at(-1).includes("authorizes no new I/O"));
});
