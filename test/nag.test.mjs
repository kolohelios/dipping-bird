import assert from "node:assert/strict";
import test from "node:test";
import { registerNag } from "../extensions/nag.ts";
import { harness } from "./harness.mjs";

const stopped = (h) =>
  h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
const context = (h, messages) => h.handlers.get("context")({ messages }, h.ctx);
const pending = (h) => ({ ...h.customMessages.at(-1), role: "custom" });
const status = async (h) =>
  (await h.tool("nag", { action: "status" })).content[0].text;

test("Nag aliases and tools share state without executing commands or launching a turn", async () => {
  const h = harness();
  await h.nag("");
  assert.match(h.notifications.at(-1)[0], /off/);
  await h.nag("on");
  assert.match(h.notifications.at(-1)[0], /Set a prompt/);
  await h.rawCommand("nag Keep editing");
  await h.nag("set Read tests");
  assert.deepEqual(h.messages, []);
  assert.deepEqual(h.calls, []);
  await h.settle();
  const message = pending(h);
  assert.doesNotMatch(message.content, /Read tests/);
  assert.match(
    (await context(h, [message])).messages[0].content,
    /nag: on[\s\S]*Read tests/,
  );
  await context(h, [message]);
  assert.match(await status(h), /Count: 1/);
  await h.handlers.get("message_end")({ message: { role: "user" } }, h.ctx);
  assert.deepEqual((await context(h, [message])).messages, []);
  await h.tool("nag", { action: "off" });
  assert.match(await status(h), /off.*Count: 1/);
  await assert.rejects(h.tool("nag", { action: "on" }), /was stopped/);
  await h.human("Continue Nag");
  await h.tool("nag", { action: "on" });
  assert.match(await status(h), /on.*Count: 0/);
  await assert.rejects(
    h.tool("nag", { action: "status", prompt: "invalid" }),
    /does not take/,
  );
  await h.nag("off extra");
  assert.match(h.notifications.at(-1)[0], /does not take/);
  assert.equal(h.state.aborts, 0);
});

for (const source of [
  "hook",
  "queue",
  "later user",
  "later custom",
  "off",
  "signal",
]) {
  test(`pending reminder yields to ${source} without counting or exposing its prompt`, async () => {
    const h = harness();
    await h.nag("private reminder");
    await h.settle();
    const messages = [pending(h)];
    if (source === "hook")
      h.pi.events.on("bird:yield-to-input", (claim) => claim());
    if (source === "queue") h.state.pending = true;
    if (source === "later user")
      messages.push({ role: "user", content: "priority task" });
    if (source === "later custom")
      messages.push({
        role: "custom",
        customType: "inbox",
        content: "priority task",
      });
    if (source === "off") await h.nag("off");
    if (source === "signal") h.ctx.signal = AbortSignal.abort();
    const result = await context(h, messages);
    assert.doesNotMatch(JSON.stringify(result), /private reminder/);
    assert.match(await status(h), /Count: 0/);
    if (source !== "later user" && source !== "later custom") {
      for (const stopReason of ["error", "aborted"])
        assert.equal(
          await h.handlers.get("message_end")(
            { message: { role: "assistant", stopReason } },
            h.ctx,
          ),
          undefined,
        );
      const end = await h.handlers.get("message_end")(
        {
          message: { role: "assistant", content: [{}], stopReason: "toolUse" },
        },
        h.ctx,
      );
      assert.deepEqual(end.message.content, []);
    }
    assert.equal(h.state.aborts, 0);
  });
}

test("higher-priority hooks, queues, continuations and provider errors suppress new reminders", async () => {
  for (const kind of ["hook", "queue", "continue", "error"]) {
    const h = harness();
    await h.nag("work");
    if (kind === "hook")
      h.pi.events.on("bird:yield-to-input", (claim) => claim());
    if (kind === "queue") h.state.pending = true;
    await h.settle(
      kind === "error" ? "error" : "completed",
      kind === "continue",
    );
    await stopped(h);
    assert.deepEqual(h.customMessages, []);
  }
});

test("redirects are read at delivery; explicit stops cannot be bypassed before fresh input", async () => {
  const h = harness();
  await h.nag("old goal");
  await h.settle();
  await h.tool("nag", { action: "set", prompt: "new goal" });
  assert.match(
    (await context(h, [pending(h)])).messages[0].content,
    /new goal/,
  );
  await h.handlers.get("agent_settled")({ aborted: true }, h.ctx);
  await assert.rejects(h.tool("nag", { action: "on" }), /was stopped/);
  await h.handlers.get("input")(
    { source: "extension", text: "continue" },
    h.ctx,
  );
  await assert.rejects(h.tool("nag", { action: "on" }), /was stopped/);
  await h.human("Use Nag again");
  await h.tool("nag", { action: "on" });
  await h.rawCommand("stop");
  assert.match(await status(h), /off/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    h.tool("nag", { action: "on" }, controller.signal),
    /cancelled/,
  );
});

test("restoration is session-scoped and a malformed entry cannot arm Nag", async () => {
  const h = harness([
    {
      type: "custom",
      customType: "pi-nag-state",
      data: { enabled: true, prompt: "saved", count: 3 },
    },
  ]);
  await h.handlers.get("session_start")({}, h.ctx);
  assert.match(await status(h), /off.*Count: 3.*saved/);
  h.entries.push({ type: "custom", customType: "pi-nag-state", data: null });
  await h.handlers.get("session_tree")({}, h.ctx);
  assert.match(await status(h), /off.*Count: 0/);
});

test("priority listeners can stop Nag synchronously before projection", async () => {
  for (const phase of ["boundary", "context"]) {
    const h = harness();
    await h.nag("private goal");
    if (phase === "context") await h.settle();
    h.pi.events.on("bird:yield-to-input", () => {
      void h.nag("off");
    });
    if (phase === "boundary") assert.equal(await h.settle(), undefined);
    else
      assert.doesNotMatch(
        JSON.stringify(await context(h, [pending(h)])),
        /private goal/,
      );
    assert.match(await status(h), /off.*Count: 0/);
  }
});

test("a later custom follow-up cannot inherit an already projected reminder", async () => {
  const h = harness();
  await h.nag("private goal");
  await h.settle();
  const message = pending(h);
  await context(h, [message]);
  const result = await context(h, [
    message,
    { role: "custom", customType: "inbox", content: "priority" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private goal/);
  assert.match(await status(h), /Count: 1/);
});

test("a failed stop reserves its mode and can be retried through /bird stop", async () => {
  const h = harness();
  await h.nag("work");
  const append = h.pi.appendEntry;
  h.pi.appendEntry = () => {
    throw new Error("write failed");
  };
  await h.nag("off");
  await h.human("Switch to Bird");
  await assert.rejects(h.tool("bird", { action: "start" }), /Stop the active/);
  h.pi.appendEntry = append;
  await h.rawCommand("stop");
  await h.handlers.get("session_start")({}, h.ctx);
  assert.match(await status(h), /off/);
});

test("cosmetic status and marker lookup failures don't cancel a counted projection", async () => {
  const h = harness();
  h.ctx.ui.setStatus = () => {
    throw new Error("UI gone");
  };
  h.ctx.sessionManager.getSessionFile = () => {
    throw new Error("lookup failed");
  };
  await h.nag("work");
  await h.settle();
  assert.match(JSON.stringify(await context(h, [pending(h)])), /nag: on/);
  assert.match(await status(h), /on.*Count: 1/);
});

test("detached sidecar failures are safe after their UI runner is replaced", async () => {
  const h = harness();
  h.handlers.clear();
  const writing = Promise.withResolvers();
  const nag = registerNag(
    h.pi,
    { show() {}, canArm: () => true, userStopped() {}, userDelivered() {} },
    () => writing.promise,
  );
  h.ctx.sessionManager.getSessionFile = () => "session.jsonl";
  nag.command("work", h.ctx);
  await h.settle();
  h.entries.push({
    type: "custom_message",
    customType: "pi-nag",
    id: "entry",
    timestamp: "time",
  });
  await context(h, [pending(h)]);
  Object.defineProperty(h.ctx, "ui", {
    get() {
      throw new Error("runner replaced");
    },
  });
  writing.reject(new Error("write failed"));
  await new Promise(setImmediate);
});

test("submitted or locally handled input cannot unlock a stopped tool batch", async () => {
  const h = harness();
  await h.nag("work");
  await h.nag("off");
  await h.handlers.get("input")(
    { source: "interactive", text: "not accepted" },
    h.ctx,
  );
  await assert.rejects(h.tool("nag", { action: "on" }), /was stopped/);
  await assert.rejects(h.tool("bird", { action: "start" }), /fresh user input/);
  await h.handlers.get("message_end")(
    { message: { role: "user", content: "different" } },
    h.ctx,
  );
  await assert.rejects(h.tool("nag", { action: "on" }), /was stopped/);
  await h.handlers.get("message_end")(
    {
      message: {
        role: "user",
        content: [
          { type: "image", data: "", mimeType: "image/png" },
          { type: "text", text: "not accepted" },
        ],
      },
    },
    h.ctx,
  );
  await h.tool("nag", { action: "on" });
});

for (const throws of [false, true]) {
  test(`reentrant stop wins over count persistence (outer throws: ${throws})`, async () => {
    const h = harness();
    await h.nag("private goal");
    await h.settle();
    const append = h.pi.appendEntry;
    let nested = false;
    h.pi.appendEntry = (type, data) => {
      append(type, data);
      if (!nested && type === "pi-nag-state" && data.count === 1) {
        nested = true;
        void h.nag("off");
        if (throws) throw new Error("obsolete write failed");
      }
    };
    assert.doesNotMatch(
      JSON.stringify(await context(h, [pending(h)])),
      /private goal/,
    );
    assert.match(await status(h), /off.*Count: 0/);
  });
}

for (const order of ["before", "after"]) {
  test(`competing boundary work ${order} the Nag notice takes priority`, async () => {
    const h = harness();
    await h.nag("private goal");
    await h.settle();
    const work = { role: "custom", customType: "priority", content: "work" };
    h.entries.push({
      type: "custom_message",
      customType: "priority",
      id: "new-priority",
    });
    const messages =
      order === "before" ? [work, pending(h)] : [pending(h), work];
    assert.doesNotMatch(
      JSON.stringify(await context(h, messages)),
      /private goal/,
    );
    assert.match(await status(h), /Count: 0/);
  });
}

test("off acknowledges a stop without disclosing an unprojected prompt", async () => {
  const h = harness();
  await h.nag("private goal");
  assert.doesNotMatch(
    JSON.stringify(await h.tool("nag", { action: "off" })),
    /private goal/,
  );
});

test("Escape blocks both tools even when persisting the stop fails", async () => {
  const h = harness();
  await h.nag("work");
  const append = h.pi.appendEntry;
  h.pi.appendEntry = () => {
    throw new Error("write failed");
  };
  assert.throws(
    () => h.handlers.get("agent_settled")({ aborted: true }, h.ctx),
    /could not be saved/,
  );
  h.pi.appendEntry = append;
  await assert.rejects(h.tool("nag", { action: "on" }), /was stopped/);
  await assert.rejects(h.tool("bird", { action: "start" }), /fresh user input/);
});

for (const phase of ["on", "delivery", "off", "stop"]) {
  test(`Nag fails closed when ${phase} cannot persist`, async () => {
    const h = harness();
    if (phase !== "on") await h.nag("private goal");
    if (phase === "delivery") {
      await h.settle();
    }
    h.pi.appendEntry = () => {
      throw new Error("write failed");
    };
    if (phase === "on")
      await assert.rejects(
        h.tool("nag", { action: "on", prompt: "goal" }),
        /could not be saved/,
      );
    else if (phase === "off") await h.nag("off");
    else if (phase === "stop") await h.rawCommand("stop");
    else
      assert.doesNotMatch(
        JSON.stringify(await context(h, [pending(h)])),
        /private goal/,
      );
    assert.match(await status(h), /off.*Count: 0/);
    await h.settle();
    await stopped(h);
    assert.equal(h.customMessages.length, phase === "delivery" ? 1 : 0);
  });
}

test("sidecar writer failures are reported without retrying model work", async () => {
  for (const writer of [
    () => {
      throw new Error("fail");
    },
    async () => {
      throw new Error("fail");
    },
  ]) {
    const h = harness();
    h.handlers.clear();
    const nag = registerNag(
      h.pi,
      { show() {}, canArm: () => true, userStopped() {}, userDelivered() {} },
      writer,
    );
    h.ctx.sessionManager.getSessionFile = () => "fixture.jsonl";
    nag.command("work", h.ctx);
    await h.settle();
    h.entries.push({
      type: "custom_message",
      customType: "pi-nag",
      id: "1",
      timestamp: "time",
    });
    await context(h, [pending(h)]);
    await new Promise(setImmediate);
    assert(h.notifications.some(([message]) => /sidecar/.test(message)));
  }
});
