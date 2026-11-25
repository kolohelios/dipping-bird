import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nag from "../extensions/nag-state.ts";
import { appendNagMarker, markerForNag } from "../extensions/nag-marker.ts";

test("Nag parses command aliases, preserves disabled state on set, and resets count only on enable", () => {
  for (const action of ["on", "off", "set", "status"])
    assert.deepEqual(nag.parseCommand(action), { action });
  assert.deepEqual(nag.parseCommand("  "), { action: "status" });
  assert.deepEqual(nag.parseCommand("keep editing"), {
    action: "on",
    prompt: "keep editing",
  });
  assert.deepEqual(nag.parseCommand("onward"), {
    action: "on",
    prompt: "onward",
  });
  assert.deepEqual(nag.parseCommand("on\nfix CSV"), {
    action: "on",
    prompt: "fix CSV",
  });
  for (const command of ["status extra", "off extra"])
    assert.throws(() => nag.parseCommand(command), /does not take/);
  let state = nag.updateState(nag.initialState, "set", "fix CSV");
  assert.equal(state.enabled, false);
  state = nag.updateState(state, "on");
  assert.equal(state.count, 0);
  state = { ...state, count: 4 };
  assert.equal(nag.updateState(state, "on", "new goal").count, 4);
  assert.equal(nag.updateState(state, "off").count, 4);
  assert.equal(nag.updateState(nag.updateState(state, "off"), "on").count, 0);
  assert.equal(nag.updateState(state, "status"), state);
  for (const prompt of [undefined, "", " "])
    assert.throws(() => nag.updateState(state, "set", prompt));
  assert.throws(() => nag.updateState(nag.initialState, "on"));
  assert.match(nag.formatStatus(nag.initialState), /off.*not set/);
  assert.match(nag.statusIndicator(state), /nagging 4/);
  assert.equal(nag.statusIndicator(nag.initialState), undefined);
  assert.match(nag.nagMessage(state), /nag: on[\s\S]*fix CSV/);
});

test("malformed reminder state never enables Nag", () => {
  for (const data of [
    null,
    1,
    {},
    { enabled: false },
    { enabled: "yes", prompt: "x" },
    { enabled: true, prompt: 3 },
    { enabled: true, prompt: " " },
    ...[-1, 1.5, Infinity, "1"].map((count) => ({
      enabled: true,
      prompt: "x",
      count,
    })),
  ])
    assert.equal(nag.parseState(data), undefined);
  assert.deepEqual(
    nag.parseState({ enabled: false, prompt: "" }),
    nag.initialState,
  );
  assert.deepEqual(nag.parseState({ enabled: true, prompt: "x", count: 3 }), {
    enabled: true,
    prompt: "x",
    count: 3,
  });
});

test("the default sidecar writer appends beside its session", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bird-marker-"));
  t.after(() => rm(dir, { recursive: true }));
  const marker = {
    timestamp: "time",
    session_file: join(dir, "session.jsonl"),
    entry_id: "1",
  };
  await appendNagMarker(marker);
  await appendNagMarker({ ...marker, session_file: join(dir, "other") });
  assert.equal(
    await readFile(join(dir, "session.nags"), "utf8"),
    JSON.stringify(marker) + "\n",
  );
});

test("sidecar correlation selects only the latest reminder and excludes prompt text", async () => {
  const entry = {
    type: "custom_message",
    customType: "pi-nag",
    id: "entry-1",
    timestamp: "2026-01-01T00:00:00Z",
    content: "sensitive goal",
  };
  assert.equal(markerForNag(undefined, [entry]), undefined);
  assert.equal(markerForNag("session.jsonl", []), undefined);
  const marker = markerForNag("session.jsonl", [
    entry,
    { ...entry, id: "entry-2" },
    { type: "custom", customType: "other" },
  ]);
  assert.equal(marker.entry_id, "entry-2");
  const writes = [];
  await appendNagMarker(marker, async (...args) => {
    writes.push(args);
  });
  assert.deepEqual(writes, [
    ["session.nags", JSON.stringify(marker) + "\n", { mode: 0o600 }],
  ]);
  assert.doesNotMatch(writes[0][1], /sensitive goal/);
  await assert.rejects(
    appendNagMarker(marker, async () => {
      throw new Error("unavailable");
    }),
  );
});
