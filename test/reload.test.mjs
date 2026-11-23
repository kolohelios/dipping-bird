import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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

async function createFixture(extensionFactories) {
  const cwd = await mkdtemp(join(tmpdir(), "bird-reload-"));
  execFileSync("jj", ["git", "init", cwd]);
  const agentDir = join(cwd, ".pi", "agent");
  const installed = join(cwd, "package");
  await mkdir(join(installed, "extensions"), { recursive: true });
  await Promise.all(
    ["package.json", "extensions/index.ts", "extensions/core.ts"].map((file) =>
      copyFile(join(packageRoot, file), join(installed, file)),
    ),
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
