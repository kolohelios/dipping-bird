import assert from "node:assert/strict";
import test from "node:test";
import * as core from "../extensions/core.ts";
import { createState, deferIdentity, harness } from "./harness.mjs";

const runInitial = (h, prompt = h.messages.at(-1)) =>
  h.handlers.get("before_agent_start")({ messageType: "user", prompt }, h.ctx);
const work = {
  status: "continue",
  summary: "Authorized next step",
  evidence: ["proof.txt"],
};

test("initial arming requires an exact prompt and a fresh matching identity", async () => {
  for (const fault of ["prompt", "change", "failure", "custom"]) {
    const h = harness();
    await h.rawCommand("start Goal");
    if (fault === "change") h.state.change = "zzzzzzzz";
    if (fault === "failure") h.state.execFails = true;
    const result =
      fault === "custom"
        ? await h.handlers.get("before_agent_start")(
            { messageType: "custom" },
            h.ctx,
          )
        : await runInitial(
            h,
            h.messages[0] + (fault === "prompt" ? " changed" : ""),
          );
    assert.equal(result, undefined);
    h.handlers.get("agent_start")({}, h.ctx);
    assert.equal(h.latest().mode, "paused");
    assert.equal(await h.settle(), undefined);
    assert.equal(h.state.aborts, ["custom", "prompt"].includes(fault) ? 0 : 1);
  }
});

test("normal settlement cancels an in-flight initial preflight", async () => {
  const h = harness();
  await h.rawCommand("start Goal");
  const finish = deferIdentity(h);
  const pending = runInitial(h);
  await h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
  finish();
  await pending;
  h.handlers.get("agent_start")({}, h.ctx);
  assert.equal(h.latest().mode, "paused");
  assert.equal(h.state.aborts, 1);
});

test("queued initial work cannot arm after its elapsed window or clock rollback", async (t) => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  for (const later of [99, 100 + core.MAX_ELAPSED_MS]) {
    now = 100;
    const h = harness();
    await h.rawCommand("start Goal");
    now = later;
    await runInitial(h);
    h.handlers.get("agent_start")({}, h.ctx);
    assert.equal(h.latest().mode, "paused");
    assert.equal(h.state.aborts, 1);
  }
});

test("the window is checked again when Pi finally starts the run", async (t) => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  const h = harness();
  await h.rawCommand("start Goal");
  await runInitial(h);
  now += core.MAX_ELAPSED_MS;
  h.handlers.get("agent_start")({}, h.ctx);
  assert.equal(h.latest().mode, "paused");
  assert.equal(h.state.aborts, 1);
});

test("queued extension input does not cancel the initial handshake", async () => {
  const h = harness();
  await h.rawCommand("start Goal");
  await h.handlers.get("input")(
    { source: "extension", text: h.messages[0] },
    h.ctx,
  );
  await runInitial(h);
  assert.equal(h.latest().mode, "paused");
  h.handlers.get("agent_start")({}, h.ctx);
  assert.equal(h.latest().mode, "running");
  assert.equal(h.state.aborts, 0);
});

for (const lifecycle of [
  "session_start",
  "session_tree",
  "session_shutdown",
  "agent_settled",
  "input",
]) {
  test(`${lifecycle} invalidates an in-flight initial preflight`, async () => {
    const h = harness();
    await h.rawCommand("start Goal");
    const finish = deferIdentity(h);
    const preflight = runInitial(h);
    await h.handlers.get(lifecycle)(
      { aborted: true, source: "rpc", text: "pause" },
      h.ctx,
    );
    finish();
    await preflight;
    h.handlers.get("agent_start")({}, h.ctx);
    assert.equal(h.latest().mode, "paused");
    assert.equal(h.state.aborts, 1);
    assert.equal(await h.settle(), undefined);
  });
}

test("restoration interrupts pending checkpoints and continuations", async () => {
  for (const operation of ["checkpoint", "settle", "context"]) {
    const h = harness();
    await h.command("start Goal");
    const finish = deferIdentity(h);
    const pending =
      operation === "checkpoint"
        ? h.checkpoint(work)
        : operation === "settle"
          ? h.settle()
          : h.handlers.get("before_agent_start")(
              { messageType: "custom" },
              h.ctx,
            );
    await h.handlers.get("session_tree")({}, h.ctx);
    finish();
    if (operation === "checkpoint") await assert.rejects(pending, /changed/);
    else assert.equal(await pending, undefined);
    assert.equal(h.latest().mode, "paused");
  }
});

test("concurrent checkpoints cannot overwrite a terminal report", async () => {
  const h = harness();
  await h.command("start Goal");
  const finish = deferIdentity(h);
  const completion = h.checkpoint({ ...work, status: "complete" });
  const continuation = h.checkpoint(work);
  finish();
  await completion;
  await assert.rejects(continuation, /changed/);
  assert.equal(h.latest().mode, "review");
});

test("later invalid persistence clears earlier valid state on the active branch", async () => {
  const h = harness([
    { type: "custom", customType: core.STATE_KEY, data: createState() },
    { type: "custom", customType: "another-extension", data: createState() },
    { type: "custom", customType: core.STATE_KEY, data: null },
  ]);
  await h.handlers.get("session_start")({}, h.ctx);
  assert.equal(await h.settle(), undefined);
  await assert.rejects(h.checkpoint(work), /not running/);
});

test("identity errors are sanitized and time-bounded", async () => {
  for (const result of [
    { code: 0, killed: true, stdout: "abcdefgh" },
    { code: 0, killed: false, stdout: "bad" },
    { code: 1, killed: false, stdout: "abcdefgh" },
  ]) {
    const h = harness();
    h.pi.exec = async (_program, _args, options) => {
      assert.equal(options.timeout, 5000);
      return { ...result, stderr: "sensitive upstream error" };
    };
    await h.command("start Goal");
    assert.equal(h.messages.length, 0);
    assert(!JSON.stringify(h.notifications).includes("sensitive"));
  }
  const h = harness();
  h.pi.exec = async () => {
    throw new Error("sensitive upstream exception");
  };
  await h.command("start Goal");
  assert(!JSON.stringify(h.notifications).includes("sensitive"));
});

test("active identity lookup failures pause instead of continuing", async () => {
  for (const fault of ["exec", "throw", "cwd"]) {
    const h = harness();
    await h.command("start Goal");
    if (fault === "exec") h.state.execFails = true;
    if (fault === "throw")
      h.pi.exec = async () => {
        throw new Error("private failure");
      };
    if (fault === "cwd") h.ctx.cwd = "/missing-bird-test-directory";
    assert.equal((await h.settle()).continue, undefined);
    assert.equal(h.latest().mode, "paused");
    assert(!JSON.stringify(h.notifications).includes("private failure"));
  }
});

test("an aborted/error boundary still stops when other messages are pending", async () => {
  for (const outcome of ["error", "aborted"]) {
    const h = harness();
    await h.command("start Goal");
    h.state.pending = true;
    const prior = { type: "custom", customType: "other-extension", data: 1 };
    const result = await h.settle(outcome, true, [prior]);
    assert.equal(result.continue, undefined);
    assert.equal(h.latest().mode, "paused");
    assert.deepEqual(result.entries[0], prior);
  }
});

test("continuations append to, rather than replace, prior extension proposals", async () => {
  const h = harness();
  await h.command("start Goal");
  const prior = { type: "custom", customType: "other-extension", data: 1 };
  const result = await h.settle("completed", false, [prior]);
  assert.equal(result.continue, true);
  assert.deepEqual(result.entries[0], prior);
  assert.equal(result.entries[1].customType, core.STATE_KEY);
  assert.equal(result.entries[2].customType, "bird-continue");
});
