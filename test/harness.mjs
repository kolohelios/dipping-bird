import { realpathSync } from "node:fs";
import * as core from "../extensions/core.ts";
import factory from "../extensions/index.ts";
import { createEventBus } from "@earendil-works/pi-coding-agent";

export function harness(branch = []) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [...branch];
  const notifications = [];
  const messages = [];
  const customMessages = [];
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
      getSessionFile: () => undefined,
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
      const previous = handlers.get(name);
      const merge = (before, after) =>
        before && after ? { ...before, ...after } : (after ?? before);
      const next = (result, event, ctx) => {
        const after = handler({ ...event, ...result }, ctx);
        return after instanceof Promise
          ? after.then((value) => merge(result, value))
          : merge(result, after);
      };
      handlers.set(
        name,
        previous
          ? (event, ctx) => {
              const result = previous(event, ctx);
              return result instanceof Promise
                ? result.then((value) => next(value, event, ctx))
                : next(result, event, ctx);
            }
          : handler,
      );
      return () => handlers.delete(name);
    },
    events: createEventBus(),
    sendMessage: (message) => customMessages.push(message),
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
    customMessages,
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
    tool: (name, params, signal) =>
      tools.get(name).execute("test", params, signal, undefined, ctx),
    nag: (args) => commands.get("nag").handler(args, ctx),
    async human(text) {
      await handlers.get("input")({ source: "interactive", text }, ctx);
      await handlers.get("message_end")(
        { message: { role: "user", content: text } },
        ctx,
      );
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
        {
          outcome,
          continue: continued,
          entries: entriesBefore,
          context: { pendingMessages: [] },
        },
        ctx,
      );
      if (result?.entries) {
        entries.push(...result.entries);
        customMessages.push(
          ...result.entries.filter((entry) => entry.type === "custom_message"),
        );
      }
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
