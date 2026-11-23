import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  advance,
  checkpoint,
  hasBudget,
  MAX_CONTINUATIONS,
  MAX_ELAPSED_MS,
  pause,
  prompt,
  readStartReceipt,
  restore,
  start,
  START_KEY,
  STATE_KEY,
  type State,
} from "./core.ts";

const DEFAULT_GOAL =
  "Finish the current conversation's task against its existing acceptance criteria and specs. Require evidence for every applicable criterion, native acceptance where required, and resolution of owner/vendor holds. Do not substitute offline test counts, more planning, or harness scaffolding for delivery.";

export default function dippingBird(pi: ExtensionAPI): void {
  let state: State | undefined;
  let revision = 0;
  let pendingStart:
    { state: State; prompt: string; ready: boolean } | undefined;

  const show = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(
      "dipping-bird",
      state
        ? `bird: ${state.mode === "review" ? "completion reported" : state.mode} ${state.continuations}/${MAX_CONTINUATIONS}`
        : undefined,
    );
  };
  const save = (ctx: ExtensionContext, next: State): void => {
    if (state !== next) revision++;
    state = next;
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
    state = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_KEY)
        state = restore(entry.data);
    }
    if (state) save(ctx, state);
    else show(ctx);
  };

  pi.registerCommand("bird", {
    description:
      "Acceptance-driven continuation: /bird start [goal], /bird stop, /bird status",
    handler: async (args, ctx) => {
      const [action, ...words] = args.trim().split(/\s+/);
      if (action === "status" || !action) {
        const remaining = state
          ? Math.max(
              0,
              Math.ceil(
                (MAX_ELAPSED_MS - (Date.now() - state.startedAt)) / 60000,
              ),
            )
          : 0;
        ctx.ui.notify(
          state
            ? `Bird: ${state.mode === "review" ? "completion reported — inspect evidence; not independently certified" : state.mode}\nJJ change: ${state.change}; continuations ${state.continuations}/${MAX_CONTINUATIONS}; ${remaining} minutes left, checked between runs.\nGoal: ${state.goal}\nCheckpoint: ${state.summary}\nEvidence: ${state.evidence.join("; ") || "none"}`
            : "Bird is not started. Use /bird start to supervise this task.",
          "info",
        );
        return;
      }
      if (action === "stop") {
        pendingStart = undefined;
        revision++;
        if (state) save(ctx, pause(state, "Stopped explicitly by the user."));
        ctx.abort();
        ctx.ui.notify(
          "Bird stopped. Any delayed start will be aborted.",
          "info",
        );
        return;
      }
      if (action !== "start") {
        ctx.ui.notify("Usage: /bird start [goal] | stop | status", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Wait for the current run or press Escape before starting Bird.",
          "warning",
        );
        return;
      }
      pendingStart = undefined;
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
      if (state) save(ctx, pause(state, "User requested a stop/pause."));
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const birdStart =
      event.messageType === "user" && consumeStart(ctx, event.prompt);
    const pending = pendingStart;
    if (pending) {
      pendingStart = undefined;
      const ticket = revision;
      if (
        event.messageType === "user" &&
        event.prompt === pending.prompt &&
        (await sameIdentity(ctx, pending.state)) &&
        revision === ticket &&
        hasBudget(pending.state, Date.now())
      ) {
        pendingStart = { ...pending, ready: true };
      }
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
