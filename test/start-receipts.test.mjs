import assert from "node:assert/strict";
import test from "node:test";
import { readStartReceipt, START_KEY, STATE_KEY } from "../extensions/core.ts";
import { harness } from "./harness.mjs";

const run = (h, prompt) =>
  h.handlers.get("before_agent_start")({ messageType: "user", prompt }, h.ctx);

for (const raw of [
  undefined,
  null,
  "receipt",
  {},
  { prompt: 1 },
  { prompt: "issued" },
  { prompt: "issued", consumed: "false" },
]) {
  test(`rejects malformed issuance receipt ${JSON.stringify(raw)}`, () => {
    assert.equal(readStartReceipt(raw), undefined);
  });
}

test("parses issuance and consumption without changing the receipt", () => {
  for (const consumed of [false, true]) {
    const raw = Object.freeze({ prompt: "issued", consumed });
    assert.deepEqual(readStartReceipt(raw), raw);
  }
});

test("recreated factories reject each pending issued prompt, but only once", async () => {
  const original = harness();
  await original.rawCommand("start First goal");
  await original.rawCommand("stop");
  await original.rawCommand("start Second goal");
  await original.rawCommand("stop");
  const restored = harness(original.entries);
  await restored.handlers.get("session_start")(
    { reason: "reload" },
    restored.ctx,
  );
  for (const text of original.messages) {
    await run(restored, text);
    assert.equal(restored.latest().mode, "paused");
  }
  assert.equal(restored.state.aborts, 2);
  const again = harness(restored.entries);
  await again.handlers.get("session_start")({ reason: "reload" }, again.ctx);
  for (const text of original.messages) await run(again, text);
  assert.equal(again.state.aborts, 0);
});

test("a consumed prompt pasted after reload is ordinary manual input", async () => {
  const original = harness();
  await original.command("start Goal");
  const restored = harness(original.entries);
  await restored.handlers.get("session_start")(
    { reason: "reload" },
    restored.ctx,
  );
  await run(restored, original.messages[0]);
  assert.equal(restored.state.aborts, 0);
  assert.equal(restored.latest().mode, "paused");
});

test("unrelated or malformed receipt data cannot reject ordinary text", async () => {
  const h = harness([
    { type: "custom", customType: START_KEY, data: null },
    {
      type: "custom",
      customType: "other",
      data: { prompt: "manual", consumed: false },
    },
    {
      type: "custom",
      customType: START_KEY,
      data: { prompt: "different", consumed: false },
    },
  ]);
  await run(h, "manual");
  assert.equal(h.state.aborts, 0);
});

for (const failedType of [STATE_KEY, START_KEY]) {
  test(`a failed ${failedType} write cannot arm supervision`, async () => {
    const h = harness();
    const append = h.pi.appendEntry;
    h.pi.appendEntry = (type, data) => {
      if (type === failedType) throw new Error("session storage unavailable");
      append(type, data);
    };
    await h.rawCommand("start Goal");
    assert.equal(h.messages.length, 0);
    h.pi.appendEntry = append;
    assert.equal(await run(h, "manual input"), undefined);
    assert.equal(await h.settle(), undefined);
    await h.command("start Goal");
    assert.equal(h.latest().mode, "running");
  });
}

test("a submission that queues then throws still leaves a cancellation receipt", async () => {
  const h = harness();
  h.pi.sendUserMessage = (text) => {
    h.messages.push(text);
    throw new Error("submission failed after queueing");
  };
  await h.rawCommand("start Goal");
  const restored = harness(h.entries);
  await restored.handlers.get("session_start")(
    { reason: "reload" },
    restored.ctx,
  );
  await run(restored, h.messages[0]);
  assert.equal(restored.state.aborts, 1);
  assert.equal(restored.latest().mode, "paused");
});
