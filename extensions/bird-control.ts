import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BirdError, prompt, type State } from "./core.ts";

export function registerBirdControl(
  pi: ExtensionAPI,
  control: {
    status: () => string;
    pause: (ctx: ExtensionContext) => void;
    arm: (
      action: "start" | "resume",
      goal: string | undefined,
      signal: AbortSignal | undefined,
      ctx: ExtensionContext,
    ) => Promise<State>;
  },
): void {
  pi.registerTool({
    name: "bird",
    label: "Bird supervision",
    exposure: "model-only",
    executionMode: "sequential",
    description:
      "Only on the user's request, start supervised Bird in the current turn, resume the saved goal within its original jj pin and budget, pause supervision without aborting work, or inspect status. Use bird_checkpoint for progress, blockers, and completion. Never replace a saved window, re-arm after an explicit stop without fresh user input, or switch to Nag to bypass a supervision stop. This grants no task or tool permissions.",
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("start"),
          Type.Literal("resume"),
          Type.Literal("pause"),
          Type.Literal("status"),
        ]),
        goal: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, { action, goal }, signal, _update, ctx) {
      if (signal?.aborted) throw new BirdError("Bird command cancelled.");
      if (goal !== undefined && action !== "start")
        throw new BirdError("Only start takes a goal.");
      if (action === "pause") control.pause(ctx);
      else if (action !== "status") {
        const state = await control.arm(action, goal, signal, ctx);
        return {
          content: [{ type: "text", text: prompt(state) }],
          details: undefined,
        };
      }
      return {
        content: [{ type: "text", text: control.status() }],
        details: undefined,
      };
    },
  });
}
