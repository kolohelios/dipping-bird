import { realpathSync } from "node:fs";
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
    checkpoint: (params, signal) =>
      tools
        .get("bird_checkpoint")
        .execute("test", params, signal, undefined, ctx),
    latest: () =>
      entries.findLast(
        (entry) =>
          entry.type === "custom" && entry.customType === core.STATE_KEY,
      )?.data,
    async settle(outcome = "completed", continued = false, entriesBefore = []) {
      const result = await handlers.get("agent_before_settle")(
        { outcome, continue: continued, entries: entriesBefore },
        ctx,
      );
      if (result?.entries) entries.push(...result.entries);
      return result;
    },
  };
}

export const createState = () =>
  core.start(
    "Complete acceptance with native evidence",
    realpathSync(process.cwd()),
    "ovqmlnlt",
    Date.now(),
  );

export function deferIdentity(h) {
  const result = Promise.withResolvers();
  h.pi.exec = () => result.promise;
  return () =>
    result.resolve({
      code: 0,
      killed: false,
      stdout: h.state.change,
      stderr: "",
    });
}
