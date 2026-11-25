import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { STATE_KEY } from "../extensions/core.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

async function createFixture(extensionFactories, jjWorkspace = true) {
  const cwd = await mkdtemp(join(tmpdir(), "bird-reload-"));
  if (jjWorkspace) execFileSync("jj", ["git", "init", cwd]);
  const agentDir = join(cwd, ".pi", "agent");
  const installed = join(cwd, "package");
  await mkdir(join(installed, "extensions"), { recursive: true });
  await Promise.all(
    [
      "package.json",
      ...(await readdir(join(packageRoot, "extensions"))).map((file) =>
        join("extensions", file),
      ),
    ].map((file) => copyFile(join(packageRoot, file), join(installed, file))),
  );
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await symlink(installed, join(agentDir, "extensions", "bird"));
  const settingsManager = SettingsManager.inMemory({
    cacheWarming: "off",
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  assert.equal(
    resourceLoader.getExtensions().extensions.length,
    1 + extensionFactories.length,
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    settingsManager,
    sessionManager,
    modelRuntime,
    noTools: true,
  });
  return { cwd, session, sessionManager, modelRuntime };
}

for (const mode of [
  "nag",
  "bird",
  "nag with inbox",
  "nag with late priority",
  "nag with custom follow-up",
  "nag with mode switch",
  "nag with failed notice",
]) {
  test(
    `SDK executes ${mode} controls and finishes without bypassing queued work`,
    { timeout: 15000 },
    async (t) => {
      const requests = [];
      const late = mode === "nag with late priority";
      const switching = mode === "nag with mode switch";
      const noticeFailure = mode === "nag with failed notice";
      const customFollowUp = mode === "nag with custom follow-up";
      let queuedCustom = false;
      let priorityChecks = 0;
      let pendingInbox = mode === "nag with inbox";
      const complete = Promise.withResolvers();
      const fixture = await createFixture(
        [
          (pi) => {
            pi.events.on("bird:yield-to-input", (claim) => {
              if (pendingInbox || (late && ++priorityChecks >= 2)) claim();
            });
            pi.on("agent_before_settle", () => {
              if (customFollowUp && requests.length === 2 && !queuedCustom) {
                queuedCustom = true;
                pi.sendMessage(
                  {
                    customType: "fixture-inbox",
                    content: "Native custom task",
                    display: true,
                  },
                  { deliverAs: "followUp" },
                );
              }
            });
            pi.on("agent_settled", () => {
              if (pendingInbox && requests.length === 2) {
                pendingInbox = false;
                pi.sendUserMessage("Priority inbox task");
              }
            });
          },
        ],
        mode === "bird" || switching,
      );
      const { cwd, session, sessionManager, modelRuntime } = fixture;
      t.after(async () => {
        await session.abort();
        session.dispose();
        await rm(cwd, { recursive: true });
      });
      t.mock.method(modelRuntime, "checkAuth", async () => ({
        apiKey: "offline-fixture",
      }));
      if (noticeFailure) {
        const append =
          sessionManager.appendCustomMessageEntry.bind(sessionManager);
        t.mock.method(
          sessionManager,
          "appendCustomMessageEntry",
          (type, ...args) => {
            if (type === "pi-nag")
              throw new Error("fixture notice write failed");
            return append(type, ...args);
          },
        );
      }
      const target = noticeFailure
        ? 2
        : late || switching
          ? 3
          : mode === "nag with inbox" || customFollowUp
            ? 5
            : 4;
      t.mock.method(session.agent, "streamFunction", (model, context) => {
        requests.push(context.messages);
        const count = requests.length;
        const start =
          mode === "bird"
            ? {
                name: "bird",
                arguments: { action: "start", goal: "Verify this fixture" },
              }
            : {
                name: "nag",
                arguments: { action: "on", prompt: "Finish this fixture" },
              };
        const finish =
          mode === "bird"
            ? {
                name: "bird_checkpoint",
                arguments: {
                  status: "complete",
                  summary: "Fixture complete",
                  evidence: ["Offline boundary verified"],
                },
              }
            : { name: "nag", arguments: { action: "off" } };
        const call =
          count === 1
            ? start
            : late && count === 3
              ? {
                  name: "nag",
                  arguments: { action: "on", prompt: "forbidden rearm" },
                }
              : !late && count === target - 1
                ? finish
                : undefined;
        const message = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          content: call
            ? [
                { type: "toolCall", id: `call-${count}`, ...call },
                ...(switching && count === 2
                  ? [
                      {
                        type: "toolCall",
                        id: "forbidden-switch",
                        name: "bird",
                        arguments: { action: "start", goal: "Bypass the stop" },
                      },
                    ]
                  : []),
              ]
            : [
                {
                  type: "text",
                  text: count < target ? "Still working" : "Done",
                },
              ],
          stopReason: call ? "toolUse" : "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
        return stream;
      });
      session.subscribe((event) => {
        if (event.type === "agent_settled" && requests.length >= target)
          complete.resolve();
      });
      await session.bindExtensions({});
      const run = session.prompt(
        "Use the selected continuation tool to complete this fixture.",
      );
      if (noticeFailure)
        await assert.rejects(run, /fixture notice write failed/);
      else await run;
      await complete.promise;
      assert.equal(
        requests.length,
        target,
        JSON.stringify(
          requests.map((messages) =>
            messages.map((message) => ({
              role: message.role,
              text:
                typeof message.content === "string"
                  ? message.content
                  : message.content
                      ?.filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("\n"),
            })),
          ),
        ),
      );
      assert.equal(
        requests
          .flat()
          .some((message) => message.role === "toolResult" && message.isError),
        switching,
      );
      const saved = sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom");
      if (mode === "bird")
        assert.equal(
          saved.findLast((entry) => entry.customType === STATE_KEY).data.mode,
          "review",
        );
      else {
        const nag = saved.findLast(
          (entry) => entry.customType === "pi-nag-state",
        ).data;
        assert.equal(nag.enabled, late);
        assert.equal(nag.count, late || switching || noticeFailure ? 0 : 1);
        assert.equal(nag.prompt, "Finish this fixture");
        if (late)
          assert.match(
            JSON.stringify(requests.at(-1)),
            /reminder was cancelled/,
          );
        else if (!switching && !noticeFailure)
          assert.match(
            JSON.stringify(customFollowUp ? requests[2] : requests.at(-2)),
            /nag: on/,
          );
        if (switching)
          assert.equal(
            saved.some((entry) => entry.customType === STATE_KEY),
            false,
          );
      }
      if (customFollowUp) {
        assert.match(JSON.stringify(requests.at(-1)), /Native custom task/);
        assert.doesNotMatch(JSON.stringify(requests.at(-1)), /nag: on/);
      }
      if (mode === "nag with inbox") {
        assert.match(JSON.stringify(requests[2]), /Priority inbox task/);
        assert.doesNotMatch(JSON.stringify(requests[2]), /nag: on/);
      }
    },
  );
}

for (const phase of ["input", "authentication"]) {
  for (const action of ["stop", "reload", "stop then reload"]) {
    test(
      `${action} rejects startup delayed in ${phase}`,
      { timeout: 15000 },
      async (t) => {
        const entered = Promise.withResolvers();
        const release = Promise.withResolvers();
        const settled = Promise.withResolvers();
        const hold = async () => {
          entered.resolve();
          await release.promise;
        };
        const fixture = await createFixture(
          phase === "input"
            ? [
                (pi) =>
                  pi.on("input", async (event) => {
                    if (event.source === "extension") await hold();
                  }),
              ]
            : [],
        );
        const { cwd, session, sessionManager, modelRuntime } = fixture;
        t.mock.method(modelRuntime, "checkAuth", async () => {
          if (phase === "authentication") await hold();
          return { apiKey: "offline-fixture" };
        });
        const requests = [];
        t.mock.method(
          session.agent,
          "streamFunction",
          (_model, _context, options) => {
            requests.push(options.signal.aborted);
            throw new Error("Offline provider fixture");
          },
        );
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "agent_settled") settled.resolve(event);
        });
        const latestState = () =>
          sessionManager
            .getBranch()
            .findLast(
              (entry) =>
                entry.type === "custom" && entry.customType === STATE_KEY,
            )?.data;
        try {
          await session.bindExtensions({});
          await session.prompt("/bird start");
          await entered.promise;
          assert.equal(session.isStreaming, false);
          if (action.includes("stop")) await session.prompt("/bird stop");
          if (action.includes("reload")) await session.reload();
          release.resolve();
          assert.equal((await settled.promise).aborted, true);
          assert.deepEqual(requests, [true]);
          assert.equal(latestState().mode, "paused");
          await session.prompt("A separate manual task");
          assert.deepEqual(requests, [true, false]);
          assert.equal(latestState().mode, "paused");
        } finally {
          release.resolve();
          await session.abort();
          unsubscribe();
          session.dispose();
          await rm(cwd, { recursive: true });
        }
      },
    );
  }
}
