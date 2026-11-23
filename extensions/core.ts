export const MAX_CONTINUATIONS = 60;
export const MAX_ELAPSED_MS = 2 * 60 * 60 * 1000;
export const STATE_KEY = "dipping-bird-v1";
export const START_KEY = "dipping-bird-start-v1";

export type StartReceipt = Readonly<{ prompt: string; consumed: boolean }>;

export function readStartReceipt(raw: unknown): StartReceipt | undefined {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("prompt" in raw) ||
    typeof raw.prompt !== "string" ||
    !("consumed" in raw) ||
    typeof raw.consumed !== "boolean"
  )
    return undefined;
  return { prompt: raw.prompt, consumed: raw.consumed };
}

export type Mode = "running" | "paused" | "blocked" | "review";
export type Verdict = "continue" | "blocked" | "complete" | "pause";
export type State = Readonly<{
  version: 1;
  mode: Mode;
  goal: string;
  cwd: string;
  change: string;
  startedAt: number;
  continuations: number;
  summary: string;
  evidence: readonly string[];
}>;

export const clean = (text: string): string =>
  text.replace(/\p{Cc}/gu, " ").trim();

export function start(
  goal: string,
  cwd: string,
  change: string,
  now: number,
): State {
  const normalized = clean(goal);
  if (
    !normalized ||
    normalized.length > 4000 ||
    !cwd ||
    !Number.isFinite(now) ||
    now < 0 ||
    !/^[a-z]{8}$/.test(change)
  ) {
    throw new Error("A bounded goal and jj change identity are required.");
  }
  return {
    version: 1,
    mode: "running",
    goal: normalized,
    cwd,
    change,
    startedAt: now,
    continuations: 0,
    summary: "Started explicitly by the user.",
    evidence: [],
  };
}

export function pause(state: State, summary: string): State {
  return { ...state, mode: "paused", summary: clean(summary) };
}

export function checkpoint(
  state: State,
  verdict: Verdict,
  summary: string,
  evidence: readonly string[],
): State {
  if (state.mode !== "running")
    throw new Error("Bird is not running; use /bird start.");
  const detail = clean(summary);
  const refs = evidence.map(clean);
  if (
    !detail ||
    detail.length > 2000 ||
    refs.length > 32 ||
    refs.some((ref) => !ref || ref.length > 1000)
  ) {
    throw new Error(
      "Provide a bounded summary and nonempty evidence references.",
    );
  }
  if (verdict === "complete" && refs.length === 0) {
    throw new Error(
      "Completion requires references covering every acceptance criterion.",
    );
  }
  return {
    ...state,
    mode:
      verdict === "complete"
        ? "review"
        : verdict === "blocked"
          ? "blocked"
          : verdict === "pause"
            ? "paused"
            : "running",
    summary: detail,
    evidence: refs,
  };
}

export function hasBudget(state: State, now: number): boolean {
  return (
    Number.isFinite(now) &&
    now >= state.startedAt &&
    now - state.startedAt < MAX_ELAPSED_MS &&
    state.continuations < MAX_CONTINUATIONS
  );
}

export function advance(
  state: State,
  now: number,
  outcome: string,
  sameIdentity: boolean,
): State {
  if (state.mode !== "running") return state;
  if (outcome !== "completed")
    return pause(state, `Run ${outcome}; automatic continuation stopped.`);
  if (!sameIdentity)
    return pause(
      state,
      "Working directory or jj change differs from the start pin.",
    );
  if (!hasBudget(state, now))
    return pause(
      state,
      state.continuations >= MAX_CONTINUATIONS
        ? "60 automatic continuations reached."
        : "Two-hour continuation limit reached (checked between runs).",
    );
  return { ...state, continuations: state.continuations + 1 };
}

export function restore(raw: unknown): State | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  if (
    !("version" in raw) ||
    raw.version !== 1 ||
    !("mode" in raw) ||
    !["running", "paused", "blocked", "review"].some(
      (mode) => mode === raw.mode,
    )
  )
    return undefined;
  if (
    !("goal" in raw) ||
    typeof raw.goal !== "string" ||
    !clean(raw.goal) ||
    raw.goal.length > 4000 ||
    !("cwd" in raw) ||
    typeof raw.cwd !== "string" ||
    !raw.cwd ||
    !("change" in raw) ||
    typeof raw.change !== "string" ||
    !/^[a-z]{8}$/.test(raw.change) ||
    !("startedAt" in raw) ||
    typeof raw.startedAt !== "number" ||
    !Number.isFinite(raw.startedAt) ||
    raw.startedAt < 0 ||
    !("continuations" in raw) ||
    typeof raw.continuations !== "number" ||
    !Number.isInteger(raw.continuations) ||
    raw.continuations < 0 ||
    raw.continuations > MAX_CONTINUATIONS ||
    !("summary" in raw) ||
    typeof raw.summary !== "string" ||
    raw.summary.length > 2000 ||
    !("evidence" in raw) ||
    !Array.isArray(raw.evidence)
  )
    return undefined;
  const evidence: unknown[] = raw.evidence;
  if (
    evidence.length > 32 ||
    !evidence.every(
      (ref): ref is string =>
        typeof ref === "string" && !!clean(ref) && ref.length <= 1000,
    )
  )
    return undefined;
  return {
    version: 1,
    mode: "paused",
    goal: clean(raw.goal),
    cwd: raw.cwd,
    change: raw.change,
    startedAt: raw.startedAt,
    continuations: raw.continuations,
    summary:
      "Restored paused; /bird start explicitly resumes with the remaining limits.",
    evidence: evidence.map(clean),
  };
}

export function prompt(state: State): string {
  return `[BIRD: acceptance-driven continuation, ${state.continuations}/${MAX_CONTINUATIONS} automatic continuations]
Goal: ${state.goal}
Stay in the pinned working directory and jj change ${state.change}. Do not use Git, create a change/commit/workspace/PR, spawn helper agents, or change the task's constraints.
Work through authorized investigation, implementation, tests, and validation without asking the user to say 'keep going'. Use the existing acceptance criteria/specs, not a new planning document. A passing offline suite or partial fixture is not delivery.
Before ending, call bird_checkpoint: pause when the user cancels or asks to pause; continue for actionable authorized work; blocked only for a genuine external prerequisite/permission/decision, giving one consolidated actionable request; complete only when EVERY applicable acceptance criterion has evidence, including required native end-to-end and owner/vendor acceptance. Completion is a report for review, not certification by Bird.
Never invent approvals, renew/reset/borrow live allocations, replay uncertain operations, refresh/login/read caches as agent, expand privileges, delete unexpected resources, weaken checks, or expose sensitive data. A continuation prompt authorizes no new I/O or file modification. Follow existing write-approval and task-specific boundaries. When authority is exhausted, report blocked once rather than repeat prompts or run another diagnostic.
Checkpoint references must contain only safe paths to evidence/artifacts, hashes, test results and sanitized summaries: no credentials, claims, licensed rows, private principal/root values, raw native errors or exception chains.
Last checkpoint: ${state.summary}`;
}
