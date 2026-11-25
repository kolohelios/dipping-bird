export class NagInputError extends Error {}

export type NagState = Readonly<{
  enabled: boolean;
  prompt: string;
  count: number;
}>;
export type NagAction = "on" | "off" | "set" | "status";
export const initialState: NagState = { enabled: false, prompt: "", count: 0 };

export function updateState(
  state: NagState,
  action: NagAction,
  prompt?: string,
): NagState {
  if (action === "status") return state;
  if (action === "off") return { ...state, enabled: false };
  if (action === "set") {
    if (prompt === undefined || !prompt.trim())
      throw new NagInputError("A prompt is required.");
    return { ...state, prompt };
  }
  const nextPrompt = prompt === undefined ? state.prompt : prompt;
  if (!nextPrompt.trim())
    throw new NagInputError("Set a prompt before enabling nag.");
  return {
    enabled: true,
    prompt: nextPrompt,
    count: state.enabled ? state.count : 0,
  };
}

export function parseCommand(args: string): {
  action: NagAction;
  prompt?: string;
} {
  const text = args.trim();
  if (!text) return { action: "status" };
  const actions = ["on", "off", "set", "status"] as const;
  const action = actions.find(
    (word) =>
      text === word ||
      (text.startsWith(word) && /\s/.test(text.charAt(word.length))),
  );
  if (!action) return { action: "on", prompt: text };
  const prompt = text.slice(action.length).trim();
  if (prompt && action !== "on" && action !== "set")
    throw new NagInputError(`/nag ${action} does not take a prompt.`);
  return prompt ? { action, prompt } : { action };
}

export function parseState(data: unknown): NagState | undefined {
  if (
    !data ||
    typeof data !== "object" ||
    !("enabled" in data) ||
    !("prompt" in data)
  )
    return undefined;
  if (typeof data.enabled !== "boolean" || typeof data.prompt !== "string")
    return undefined;
  if (data.enabled && !data.prompt.trim()) return undefined;
  const count = "count" in data ? data.count : 0;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    return undefined;
  return { enabled: data.enabled, prompt: data.prompt, count };
}

export function formatStatus(state: NagState): string {
  return `Nag is ${state.enabled ? "on" : "off"}. Count: ${state.count}. Prompt: ${state.prompt || "(not set)"}`;
}
export function statusIndicator(state: NagState): string | undefined {
  return state.enabled ? `bird: nagging ${state.count}` : undefined;
}
export function nagMessage(state: NagState): string {
  return `\`\`\`pi-nag\nnag: on\n\`\`\`\n\n${state.prompt}`;
}
