import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  appendNagMarker,
  markerForNag,
  type MarkerWriter,
} from "./nag-marker.ts";
import {
  formatStatus,
  NagInputError,
  initialState,
  nagMessage,
  parseCommand,
  parseState,
  statusIndicator,
  updateState,
  type NagAction,
  type NagState,
} from "./nag-state.ts";

const STATE_TYPE = "pi-nag-state";
const MESSAGE_TYPE = "pi-nag";
const CANCELLED_NOTICE =
  "The automatic reminder was cancelled. Take no action and end this turn.";

export function registerNag(
  pi: ExtensionAPI,
  options: {
    show: (ctx: ExtensionContext) => void;
    canArm: (agent: boolean) => boolean;
    userStopped: () => void;
    userDelivered: () => void;
  },
  writeMarker: MarkerWriter = appendNagMarker,
): {
  command: (args: string, ctx: ExtensionContext) => void;
  enabled: () => boolean;
  status: () => string | undefined;
  stop: (ctx: ExtensionContext) => void;
} {
  let state: NagState = initialState;
  let pendingNag: string | undefined;
  let deliveredPrompt: string | undefined;
  let skipTools = false;
  let stoppedByUser = false;
  let dirty = false;
  let generation = 0;
  let knownEntries = new Set<string>();
  const humanPrompts = new Set<string>();

  function restore(ctx: ExtensionContext): void {
    const wasDirty = dirty;
    generation++;
    humanPrompts.clear();
    state = initialState;
    dirty = false;
    pendingNag = deliveredPrompt = undefined;
    skipTools = false;
    stoppedByUser = true;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE)
        state = parseState(entry.data) ?? initialState;
    }
    if (state.enabled || wasDirty) change("off", undefined, ctx);
    else options.show(ctx);
  }
  function save(next: NagState, ctx: ExtensionContext): boolean {
    const ticket = ++generation;
    try {
      pi.appendEntry(STATE_TYPE, next);
    } catch {
      if (ticket !== generation) return false;
      dirty = true;
      state = { ...state, enabled: false };
      options.show(ctx);
      throw new NagInputError(
        "Nag state could not be saved; Nag is off. Retry /nag off before reloading.",
      );
    }
    if (ticket !== generation) return false;
    state = next;
    dirty = false;
    options.show(ctx);
    return true;
  }
  function change(
    action: NagAction,
    prompt: string | undefined,
    ctx: ExtensionContext,
    agent = false,
  ): string {
    if (prompt !== undefined && action !== "on" && action !== "set")
      throw new NagInputError(`${action} does not take a prompt.`);
    if (action === "on" && agent && stoppedByUser)
      throw new NagInputError(
        "Nag was stopped. Wait for a new user request before re-arming.",
      );
    if (action === "on" && !options.canArm(agent))
      throw new NagInputError(
        "Nag cannot take over supervised Bird. Stop Bird first and explicitly arm Nag.",
      );
    if (action === "off") {
      humanPrompts.clear();
      stoppedByUser = true;
      options.userStopped();
    }
    const next = updateState(state, action, prompt);
    if (next !== state) save(next, ctx);
    return formatStatus(state);
  }
  function priorityInput(ctx: ExtensionContext): boolean {
    if (ctx.hasPendingMessages()) return true;
    let claimed = false;
    pi.events.emit("bird:yield-to-input", () => {
      claimed = true;
    });
    return claimed || ctx.hasPendingMessages();
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("input", (event) => {
    if (event.source !== "extension") humanPrompts.add(event.text);
  });
  pi.on("context", (event, ctx) => {
    const pendingIndex =
      pendingNag === undefined
        ? -1
        : event.messages.findIndex(
            (message) =>
              message.role === "custom" &&
              message.customType === MESSAGE_TYPE &&
              message.details === pendingNag,
          );
    let replacement = deliveredPrompt;
    const priorityAfter =
      pendingIndex !== -1 &&
      event.messages
        .slice(pendingIndex + 1)
        .some(
          (message) =>
            message.role === "user" ||
            (message.role === "custom" && message.customType !== MESSAGE_TYPE),
        );
    const competingDraft =
      pendingIndex !== -1 &&
      ctx.sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType !== MESSAGE_TYPE &&
            !knownEntries.has(entry.id),
        );
    if (priorityAfter || competingDraft) {
      pendingNag = deliveredPrompt = replacement = undefined;
      skipTools = false;
    } else if (pendingIndex !== -1 && deliveredPrompt === undefined) {
      const priority = priorityInput(ctx);
      // Event listeners may synchronously run stop commands.
      if (priority || !state.enabled || ctx.signal?.aborted) {
        pendingNag = undefined;
        replacement = CANCELLED_NOTICE;
        skipTools = true;
      } else {
        try {
          if (
            !save({ ...state, count: state.count + 1 }, ctx) ||
            !state.enabled
          ) {
            pendingNag = undefined;
            skipTools = true;
            return {
              messages: event.messages.map((message, index) =>
                index === pendingIndex && message.role === "custom"
                  ? { ...message, content: CANCELLED_NOTICE }
                  : message,
              ),
            };
          }
          deliveredPrompt = replacement = nagMessage(state);
          const warn = () => {
            try {
              ctx.ui.notify("Could not write the Nag sidecar.", "warning");
            } catch {
              /* The optional writer may finish after its runner is replaced. */
            }
          };
          try {
            const marker = markerForNag(
              ctx.sessionManager.getSessionFile(),
              ctx.sessionManager.getBranch(),
            );
            if (marker) void writeMarker(marker).catch(warn);
          } catch {
            warn();
          }
        } catch {
          pendingNag = undefined;
          replacement = CANCELLED_NOTICE;
          skipTools = true;
          ctx.ui.notify(
            "Nag state could not be saved; Nag is off. Retry /nag off before reloading.",
            "error",
          );
        }
      }
    }
    return {
      messages: event.messages.flatMap((message, i) => {
        if (message.role !== "custom" || message.customType !== MESSAGE_TYPE)
          return [message];
        return i === pendingIndex && replacement !== undefined
          ? [{ ...message, content: replacement }]
          : [];
      }),
    };
  });
  pi.on("message_end", ({ message }) => {
    if (message.role === "user") {
      if (humanPrompts.size) {
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
        if (humanPrompts.has(text)) {
          humanPrompts.clear();
          stoppedByUser = false;
          options.userDelivered();
        }
      }
      if (deliveredPrompt !== undefined)
        pendingNag = deliveredPrompt = undefined;
      skipTools = false;
    }
    if (
      !skipTools ||
      message.role !== "assistant" ||
      message.stopReason === "error" ||
      message.stopReason === "aborted"
    )
      return;
    skipTools = false;
    return { message: { ...message, content: [], stopReason: "stop" } };
  });
  pi.on("agent_before_settle", (event, ctx) => {
    if (
      event.outcome !== "completed" ||
      event.continue ||
      event.context.pendingMessages.length ||
      !state.enabled ||
      stoppedByUser
    )
      return;
    if (priorityInput(ctx) || !state.enabled || stoppedByUser) return;
    knownEntries = new Set(
      ctx.sessionManager.getBranch().map((entry) => entry.id),
    );
    pendingNag = randomUUID();
    deliveredPrompt = undefined;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: MESSAGE_TYPE,
          content: "Pi Nag: automatic continuation requested.",
          display: true,
          details: pendingNag,
        },
      ],
      continue: true,
    };
  });
  pi.on("agent_settled", (event, ctx) => {
    humanPrompts.clear();
    const unprojected =
      pendingNag !== undefined && deliveredPrompt === undefined;
    pendingNag = deliveredPrompt = undefined;
    skipTools = false;
    if ((event.aborted || unprojected) && state.enabled) {
      stoppedByUser = true;
      options.userStopped();
      change("off", undefined, ctx);
      ctx.ui.notify(
        "Nag disabled after interruption or an unprojected continuation.",
        "info",
      );
    }
  });

  function command(args: string, ctx: ExtensionContext): void {
    try {
      const parsed = parseCommand(args);
      const status = change(parsed.action, parsed.prompt, ctx);
      if (parsed.action === "on" && state.enabled) stoppedByUser = false;
      ctx.ui.notify(status, "info");
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  }
  pi.registerCommand("nag", {
    description:
      "Arm a reminder with /nag <prompt>, or use on, set, off, status",
    handler: async (args, ctx) => command(args, ctx),
  });
  pi.registerTool({
    name: "nag",
    label: "Nag",
    executionMode: "sequential",
    description:
      "On the user's request, manage reminders (#nag or /nag). Use their wording or a short standalone task and stopping condition, not an evidence checklist. Actions: on with a prompt sets and enables; on alone reuses the saved prompt; set redirects without enabling; status inspects; off stops reminders without aborting work. There is no automatic turn or time cap. Turn Nag off before completion or asking for input, feedback, or permission. A redirect alone never enables an inactive reminder. After stopping to wait for input, re-arm only when fresh user input provides a way forward. Never re-arm after an explicit user stop or use Nag to bypass supervised Bird's stop, pin, or budget. This grants no task or tool permissions.",
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("on"),
          Type.Literal("off"),
          Type.Literal("set"),
          Type.Literal("status"),
        ]),
        prompt: Type.Optional(
          Type.String({ description: "Prompt for on or set." }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, { action, prompt }, signal, _update, ctx) {
      if (signal?.aborted) throw new NagInputError("Nag command cancelled.");
      const status = change(action, prompt, ctx, true);
      return {
        content: [
          { type: "text", text: action === "off" ? "Nag is off." : status },
        ],
        details: undefined,
      };
    },
  });
  return {
    command,
    // An unsaved stop reserves the mode until storage is reconciled.
    enabled: () => state.enabled || dirty,
    status: () => statusIndicator(state),
    stop: (ctx) => {
      humanPrompts.clear();
      stoppedByUser = true;
      options.userStopped();
      if (state.enabled || dirty) {
        try {
          change("off", undefined, ctx);
        } catch {
          ctx.ui.notify(
            "Nag could not persist its stop. Retry /nag off before reloading.",
            "error",
          );
        }
      }
    },
  };
}
