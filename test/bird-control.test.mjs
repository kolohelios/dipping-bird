import assert from "node:assert/strict";
import test from "node:test";
import { harness, createState, deferIdentity } from "./harness.mjs";
import {
  MAX_CONTINUATIONS,
  MAX_ELAPSED_MS,
  STATE_KEY,
} from "../extensions/core.ts";

const input = (h) => h.human("Resume Bird");

test("the bird tool starts within the current turn and resumes only original limits", async () => {
  const h = harness();
  assert.match(
    (await h.tool("bird", { action: "status" })).content[0].text,
    /not started/,
  );
  await assert.rejects(h.tool("bird", { action: "resume" }), /No saved/);
  await assert.rejects(
    h.tool("bird", { action: "status", goal: "wrong" }),
    /Only start/,
  );
  assert.match(
    (await h.tool("bird", { action: "start", goal: "Check CSV" })).content[0]
      .text,
    /Goal: Check CSV/,
  );
  assert.deepEqual(h.messages, []);
  await assert.rejects(h.tool("bird", { action: "resume" }), /already running/);
  await assert.rejects(h.tool("bird", { action: "start" }), /already exists/);
  await h.settle();
  await assert.rejects(
    h.tool("nag", { action: "on", prompt: "go" }),
    /cannot take over/,
  );
  await h.tool("bird", { action: "pause" });
  const previous = h.latest();
  await assert.rejects(
    h.tool("bird", { action: "resume" }),
    /fresh user input/,
  );
  await assert.rejects(
    h.tool("nag", { action: "on", prompt: "go" }),
    /cannot take over/,
  );
  await input(h);
  await h.tool("bird", { action: "resume" });
  assert.equal(h.latest().startedAt, previous.startedAt);
  assert.equal(h.latest().continuations, 1);
  assert.equal(h.state.aborts, 0);
});

test("mode exclusion applies to slash commands and concurrent starts", async () => {
  const h = harness();
  await h.nag("work");
  await h.rawCommand("start Goal");
  assert.match(h.notifications.at(-1)[0], /Turn Nag off/);
  await assert.rejects(h.tool("bird", { action: "start" }), /Stop the active/);
  await h.nag("off");
  await input(h);
  const finish = deferIdentity(h);
  const starting = h.tool("bird", { action: "start" });
  await assert.rejects(h.tool("bird", { action: "start" }), /wait for Bird/);
  await input(h);
  finish();
  await assert.rejects(starting, /interrupted/);
  assert.equal(h.latest(), undefined);
});

test("agent resume refuses pin drift, elapsed limits and exhausted counts", async () => {
  for (const patch of [
    { change: "qrstuvwx" },
    { startedAt: Date.now() - MAX_ELAPSED_MS },
    { continuations: MAX_CONTINUATIONS },
  ]) {
    const h = harness([
      {
        type: "custom",
        customType: STATE_KEY,
        data: { ...createState(), ...patch },
      },
    ]);
    await h.handlers.get("session_start")({}, h.ctx);
    await input(h);
    await assert.rejects(
      h.tool("bird", { action: "resume" }),
      /pin differs|supervision cap/,
    );
    assert.equal(h.latest().mode, "paused");
    await assert.rejects(
      h.tool("nag", { action: "on", prompt: "Bypass the cap" }),
      /cannot take over/,
    );
  }
});

test("shared stops survive resource recovery until fresh user input", async () => {
  const h = harness();
  await h.nag("work");
  await h.nag("off");
  await assert.rejects(h.tool("bird", { action: "start" }), /fresh user input/);
  await h.handlers.get("session_start")({}, h.ctx);
  await assert.rejects(h.tool("nag", { action: "on" }), /was stopped/);
  await assert.rejects(h.tool("bird", { action: "start" }), /fresh user input/);
  await input(h);
  await h.tool("bird", { action: "start" });
  h.pi.appendEntry = () => {
    throw new Error("storage unavailable");
  };
  await assert.rejects(h.rawCommand("stop"), /storage unavailable/);
  assert.equal(h.state.aborts, 1);
});

test("Nag cannot arm during Bird's second identity lookup", async () => {
  const h = harness();
  await h.rawCommand("start Goal");
  const finish = deferIdentity(h);
  const starting = h.handlers.get("before_agent_start")(
    { messageType: "user", prompt: h.messages[0] },
    h.ctx,
  );
  await h.nag("work");
  assert.match(h.notifications.at(-1)[0], /cannot take over/);
  finish();
  await starting;
  h.handlers.get("agent_start")({}, h.ctx);
  assert.equal(h.latest().mode, "running");
  assert.match(
    (await h.tool("nag", { action: "status" })).content[0].text,
    /off/,
  );
});

test("a persistence failure during a tool start leaves supervision inert", async () => {
  const h = harness();
  const append = h.pi.appendEntry;
  h.pi.appendEntry = () => {
    throw new Error("storage unavailable");
  };
  await assert.rejects(
    h.tool("bird", { action: "start" }),
    /persistence failed/,
  );
  assert.equal(await h.settle(), undefined);
  await h.rawCommand("status");
  assert.match(h.notifications.at(-1)[0], /not started/);
  h.pi.appendEntry = append;
  await input(h);
  await h.tool("bird", { action: "start", goal: "Fresh attempt" });
  assert.equal(h.latest().goal, "Fresh attempt");
});

test("a shared stop during identity lookup cancels agent arming", async () => {
  const h = harness();
  const finish = deferIdentity(h);
  const starting = h.tool("bird", { action: "start" });
  await h.nag("off");
  finish();
  await assert.rejects(starting, /interrupted/);
  assert.equal(h.latest(), undefined);
});

test("canceled controls do not change state before or during identity lookup", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    h.tool("bird", { action: "start" }, controller.signal),
    /cancelled/,
  );
  const active = new AbortController();
  const finish = deferIdentity(h);
  const pending = h.tool("bird", { action: "start" }, active.signal);
  active.abort();
  finish();
  await assert.rejects(pending, /interrupted/);
  assert.equal(h.latest(), undefined);
});
