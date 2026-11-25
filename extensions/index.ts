import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  advance,
  BirdError,
  checkpoint,
  formatSupervisionStatus,
  hasBudget,
  MAX_CONTINUATIONS,
  pause,
  prompt,
  readStartReceipt,
  restore,
  resume,
  start,
  START_KEY,
  STATE_KEY,
  type State,
} from "./core.ts";
import { registerNag } from "./nag.ts";
import { registerBirdControl } from "./bird-control.ts";

const DEFAULT_GOAL =
  "Finish the current conversation's task against its existing acceptance criteria and specs. Require evidence for every applicable criterion, native acceptance where required, and resolution of owner/vendor holds. Do not substitute offline test counts, more planning, or harness scaffolding for delivery.";

export default function dippingBird(pi: ExtensionAPI): void {
  let state: State | undefined;
  let revision = 0;
  let supervisedSinceInput = false;
  let stoppedByUser = false;
  let startingSupervision = false;
  let pendingStart:
    { state: State; prompt: string; ready: boolean } | undefined;

  const show = (ctx: ExtensionContext): void => {
    try {
      ctx.ui.setStatus(
        "dipping-bird",
        nag.status() ??
          (state
            ? `bird: ${state.mode === "review" ? "completion reported" : state.mode} ${state.continuations}/${MAX_CONTINUATIONS}`
            : undefined),
      );
    } catch {
      /* Status is cosmetic and may outlive its UI runner. */
    }
  };
  const save = (ctx: ExtensionContext, next: State): void => {
    if (state !== next) revision++;
    state = next;
    if (next.mode === "running") supervisedSinceInput = true;
    pi.appendEntry(STATE_KEY, next);
    show(ctx);
  };
  const consumeStart = (ctx: ExtensionContext, text: string): boolean => {
    const receipt = ctx.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom" && entry.customType === START_KEY
          ? [readStartReceipt(entry.data)]
          : [],
      )
      .findLast((entry) => entry?.prompt === text);
    if (receipt?.consumed !== false) return false;
    pi.appendEntry(START_KEY, { prompt: text, consumed: true });
    return true;
  };
  const identity = async (
    ctx: ExtensionContext,
  ): Promise<{ cwd: string; change: string }> => {
    const cwd = realpathSync(ctx.cwd);
    const result = await pi.exec(
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
      { cwd, timeout: 5000 },
    );
    const change = result.stdout.trim();
    if (result.code !== 0 || result.killed || !/^[a-z]{8}$/.test(change)) {
      throw new Error(
        "Cannot verify the selected jj change; Bird remains paused.",
      );
    }
    return { cwd, change };
  };
  const sameIdentity = async (
    ctx: ExtensionContext,
    pin: State,
  ): Promise<boolean> => {
    try {
      const current = await identity(ctx);
      return current.cwd === pin.cwd && current.change === pin.change;
    } catch {
      return false;
    }
  };
  const recover = (ctx: ExtensionContext): void => {
    pendingStart = undefined;
    revision++;
    supervisedSinceInput = false;
    stoppedByUser = true;
    state = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_KEY)
        state = restore(entry.data);
    }
    if (state) save(ctx, state);
    else show(ctx);
  };

  const nag = registerNag(pi, {
    show,
    canArm: (agent) =>
      !startingSupervision &&
      !pendingStart &&
      state?.mode !== "running" &&
      (!agent || (!supervisedSinceInput && !stoppedByUser)),
    userStopped: () => {
      stoppedByUser = true;
    },
    userDelivered: () => {
      stoppedByUser = false;
      supervisedSinceInput = state?.mode === "running";
    },
  });
  registerBirdControl(pi, {
    status: () => formatSupervisionStatus(state, Date.now()),
    pause: (ctx) => {
      stoppedByUser = true;
      pendingStart = undefined;
      revision++;
      if (state?.mode === "running")
        save(ctx, pause(state, "Paused by the agent."));
    },
    arm: async (action, goal, signal, ctx) => {
      const busy =
        nag.enabled() || pendingStart !== undefined || startingSupervision;
      if (
        stoppedByUser ||
        (!busy && supervisedSinceInput && state?.mode !== "running")
      )
        throw new BirdError(
          "Bird stopped in this run. Wait for fresh user input before arming it.",
        );
      if (busy)
        throw new BirdError(
          "Stop the active continuation or wait for Bird to start.",
        );
      const previous = state;
      if (previous) supervisedSinceInput = true;
      if (action === "start" && previous)
        throw new BirdError(
          "A Bird window already exists. Resume it or ask the user to start a new window.",
        );
      if (action === "resume" && !previous)
        throw new BirdError("No saved Bird window to resume.");
      if (previous?.mode === "running")
        throw new BirdError("Bird is already running.");
      startingSupervision = true;
      supervisedSinceInput = true;
      const ticket = ++revision;
      try {
        const pin = await identity(ctx);
        if (revision !== ticket || signal?.aborted || stoppedByUser)
          throw new BirdError("Bird start or resume was interrupted.");
        const next = previous
          ? resume(previous, pin.cwd, pin.change, Date.now())
          : start(goal ?? DEFAULT_GOAL, pin.cwd, pin.change, Date.now());
        try {
          save(ctx, next);
        } catch {
          state = previous;
          revision++;
          show(ctx);
          throw new BirdError(
            "Session persistence failed; Bird was not armed.",
          );
        }
        return next;
      } finally {
        startingSupervision = false;
      }
    },
  });

  pi.registerCommand("bird", {
    description:
      "Supervise with /bird start [goal], or arm a reminder with /bird nag <prompt>",
    handler: async (args, ctx) => {
      const [action, ...words] = args.trim().split(/\s+/);
      if (action === "nag") {
        nag.command(args.trim().slice(3), ctx);
        return;
      }
      if (action === "status" || !action) {
        ctx.ui.notify(formatSupervisionStatus(state, Date.now()), "info");
        return;
      }
      if (action === "stop") {
        supervisedSinceInput = true;
        nag.stop(ctx);
        pendingStart = undefined;
        revision++;
        try {
          if (state) save(ctx, pause(state, "Stopped explicitly by the user."));
        } finally {
          ctx.abort();
        }
        ctx.ui.notify(
          "Bird stopped. Any delayed start will be aborted.",
          "info",
        );
        return;
      }
      if (action !== "start") {
        ctx.ui.notify(
          "Usage: /bird start [goal] | nag <prompt> | stop | status",
          "warning",
        );
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Wait for the current run or press Escape before starting Bird.",
          "warning",
        );
        return;
      }
      if (nag.enabled() || startingSupervision) {
        ctx.ui.notify(
          "Turn Nag off or wait for the current Bird start.",
          "warning",
        );
        return;
      }
      pendingStart = undefined;
      startingSupervision = true;
      stoppedByUser = false;
      const ticket = ++revision;
      try {
        const pin = await identity(ctx);
        if (revision !== ticket) return;
        const goal = words.join(" ").trim();
        if (state && !goal) {
          if (state.mode === "running") {
            ctx.ui.notify("Bird is already running.", "info");
            return;
          }
          if (pin.cwd !== state.cwd || pin.change !== state.change)
            throw new Error("Pin differs; resuming is refused.");
          if (!hasBudget(state, Date.now())) {
            ctx.ui.notify(
              "Supervision cap reached. /bird start <goal> explicitly begins a new model-work window, never a new live-I/O authorization.",
              "warning",
            );
            return;
          }
        }
        const next: State =
          state && !goal
            ? {
                ...state,
                mode: "running",
                summary:
                  "Resumed explicitly with remaining limits; no permissions renewed.",
              }
            : start(goal || DEFAULT_GOAL, pin.cwd, pin.change, Date.now());
        const initialPrompt = `[BIRD START ${randomUUID()}]\n${prompt(next)}`;
        save(ctx, pause(next, "Awaiting initial run; Bird remains paused."));
        pi.appendEntry(START_KEY, { prompt: initialPrompt, consumed: false });
        pendingStart = { state: next, prompt: initialPrompt, ready: false };
        try {
          pi.sendUserMessage(initialPrompt);
        } catch {
          pendingStart = undefined;
          save(ctx, pause(next, "Initial prompt could not be queued."));
          ctx.ui.notify(
            "Bird paused: initial prompt could not be queued.",
            "warning",
          );
        }
      } catch {
        if (revision !== ticket) return;
        if (state)
          save(
            ctx,
            pause(state, "Could not verify start/resume identity or goal."),
          );
        ctx.ui.notify(
          "Bird did not start: identity, goal or resume pin could not be verified.",
          "warning",
        );
      } finally {
        startingSupervision = false;
      }
    },
  });

  pi.registerTool({
    name: "bird_checkpoint",
    label: "Bird checkpoint",
    description:
      "While Bird is active, report actionable continuation, one genuine external blocker, user-requested pause/cancellation, or completion with evidence references covering ALL acceptance criteria. Never use test counts alone as completion or put sensitive/raw output in the checkpoint. This tool does not authorize work or independently certify completion.",
    exposure: "model-only",
    parameters: Type.Object(
      {
        status: Type.Union([
          Type.Literal("continue"),
          Type.Literal("blocked"),
          Type.Literal("complete"),
          Type.Literal("pause"),
        ]),
        summary: Type.String({ minLength: 1, maxLength: 2000 }),
        evidence: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
          maxItems: 32,
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Checkpoint cancelled.");
      if (!state || state.mode !== "running")
        throw new Error(
          "Bird is not running. Only the user can start it with /bird start.",
        );
      const pin = state;
      const ticket = revision;
      const matches = await sameIdentity(ctx, pin);
      if (signal?.aborted) throw new Error("Checkpoint cancelled.");
      if (revision !== ticket)
        throw new Error("Bird changed while checking; checkpoint refused.");
      if (!matches) {
        save(ctx, pause(pin, "Identity drift; checkpoint refused."));
        throw new Error("Bird pin differs; no checkpoint accepted.");
      }
      const next = checkpoint(
        state,
        params.status,
        params.summary,
        params.evidence,
      );
      save(ctx, next);
      const text =
        next.mode === "review"
          ? `Completion reported, not independently certified by Bird. Review criterion-by-criterion evidence: ${next.evidence.join("; ")}`
          : `Bird ${next.mode}: ${next.summary}`;
      return {
        content: [{ type: "text", text }],
        details: {
          mode: next.mode,
          summary: next.summary,
          evidence: next.evidence,
        },
      };
    },
  });

  pi.on("session_start", (_event, ctx) => recover(ctx));
  pi.on("session_tree", (_event, ctx) => recover(ctx));
  pi.on("session_compact", (_event, ctx) => {
    if (state) save(ctx, state);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    pendingStart = undefined;
    revision++;
    if (state?.mode === "running")
      save(
        ctx,
        pause(state, "Session ended/reloaded; explicitly restart Bird."),
      );
  });
  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return;
    pendingStart = undefined;
    revision++;
    if (["stop", "pause"].includes(event.text.trim().toLowerCase())) {
      supervisedSinceInput = true;
      nag.stop(ctx);
      if (state) save(ctx, pause(state, "User requested a stop/pause."));
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const birdStart =
      event.messageType === "user" && consumeStart(ctx, event.prompt);
    const pending = pendingStart;
    if (pending) {
      const ticket = revision;
      if (
        event.messageType === "user" &&
        event.prompt === pending.prompt &&
        (await sameIdentity(ctx, pending.state)) &&
        revision === ticket &&
        hasBudget(pending.state, Date.now())
      ) {
        pendingStart = { ...pending, ready: true };
      } else if (pendingStart === pending) pendingStart = undefined;
    }
    // Preflight can outlive stop; abort again once Pi owns the run.
    if (birdStart && !pendingStart?.ready) {
      ctx.abort();
      return;
    }
    if (state?.mode !== "running") return;
    const pin = state;
    const ticket = revision;
    const matches = await sameIdentity(ctx, pin);
    if (revision !== ticket) return;
    if (!matches) {
      save(ctx, pause(pin, "Working directory or jj change drifted."));
      return {
        message: {
          customType: "bird-paused",
          content:
            "Bird paused on workspace/change drift. Do not continue automatically outside the selected scope.",
          display: true,
        },
      };
    }
    return {
      message: {
        customType: "bird-context",
        content: prompt(state),
        display: false,
      },
    };
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!pendingStart?.ready) return;
    const next = pendingStart.state;
    pendingStart = undefined;
    if (!hasBudget(next, Date.now())) {
      save(
        ctx,
        pause(next, "Supervision window expired before the initial run."),
      );
      ctx.abort();
      return;
    }
    save(ctx, next);
  });
  pi.on("agent_settled", (event, ctx) => {
    pendingStart = undefined;
    revision++;
    if (!event.aborted) return;
    if (state?.mode === "running")
      save(ctx, pause(state, "Run aborted; explicitly restart Bird."));
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (state?.mode !== "running") return;
    if (
      event.outcome === "completed" &&
      (event.continue || ctx.hasPendingMessages())
    )
      return;
    const pin = state;
    const ticket = revision;
    const matches = await sameIdentity(ctx, pin);
    if (revision !== ticket) return;
    const next = advance(pin, Date.now(), event.outcome, matches);
    revision++;
    state = next;
    show(ctx);
    if (next.mode !== "running") {
      if (ctx.hasUI) ctx.ui.notify(`Bird paused: ${next.summary}`, "warning");
      return {
        entries: [
          ...event.entries,
          { type: "custom", customType: STATE_KEY, data: next },
        ],
      };
    }
    return {
      entries: [
        ...event.entries,
        { type: "custom", customType: STATE_KEY, data: next },
        {
          type: "custom_message",
          customType: "bird-continue",
          content: prompt(next),
          display: false,
        },
      ],
      continue: true,
    };
  });
}
