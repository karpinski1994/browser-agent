/*
 * Verification for the configured agent runtime integration.
 *
 * Run with: pnpm verify:runtime
 *
 * Dependency-free. Uses only a placeholder credential — never a live
 * one — and spawns short-lived `node -e` processes in place of Pi, so
 * no agent is launched and no network is touched.
 */

import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  AgentRuntimeService,
  type SpawnPi,
} from "../src/main/agentRuntimeService";
import { piConfigDirForUserData } from "../src/main/configGenerator";
import {
  buildSpawnArgs,
  buildSpawnEnv,
  redactSpawnArgs,
  resolveRuntimeConfig,
  type AgentRuntimeConfig,
  type ProviderSettingsReader,
} from "../src/main/runtimeConfig";
import { SettingsError } from "../src/main/settingsService";

/** Placeholder only. Never a live credential. */
const FAKE_API_KEY = "sk-test-placeholder-not-a-real-key";

const USER_DATA = join(homedir(), "Library", "Application Support", "agent-browser-test");
const PI_AGENT_DIR = piConfigDirForUserData(USER_DATA);

const CONFIG: AgentRuntimeConfig = {
  piAgentDir: PI_AGENT_DIR,
  providerId: "custom",
  modelId: "my-model-id",
  apiKey: FAKE_API_KEY,
  cwd: "/tmp",
};

let passed = 0;

/*
 * Capture everything the service logs so the secret-leak assertion can
 * be made against real output rather than by inspection. Test reporting
 * goes through the saved originals so results stay visible.
 */
const captured: string[] = [];
const realLog = console.log;
const realError = console.error;

console.log = (...args: unknown[]) => {
  captured.push(args.map(String).join(" "));
};
console.error = (...args: unknown[]) => {
  captured.push(args.map(String).join(" "));
};

async function check(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
    passed += 1;
    realLog(`  ok   ${name}`);
  } catch (error) {
    realError(`  FAIL ${name}`);
    realError(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A real, harmless long-lived child so exit events actually fire. */
function spawnStandstill(): ChildProcess {
  return spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
}

/*
 * Every standstill child ever created, so a failing assertion cannot
 * leak one: the exit hook reaps whatever a test did not.
 */
const allChildren: ChildProcess[] = [];

process.on("exit", () => {
  for (const child of allChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

type SpawnCall = {
  command: string;
  args: string[];
  env: unknown;
};

function makeRecorder() {
  const calls: SpawnCall[] = [];
  const children: ChildProcess[] = [];

  const spawnPi: SpawnPi = (command, args, options) => {
    calls.push({ command, args, env: options.env });

    const child = spawnStandstill();
    children.push(child);
    allChildren.push(child);

    return child as never;
  };

  return { calls, children, spawnPi };
}

/** Reap a test's children deterministically rather than waiting on GC. */
function reapAll(children: ChildProcess[]): void {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function reader(overrides: Partial<ProviderSettingsReader>): ProviderSettingsReader {
  return {
    hasConfiguredProvider: () => true,
    readProviderSettings: () => ({
      baseUrl: "https://gateway.example.com/v1",
      modelId: "my-model-id",
    }),
    readApiKey: () => FAKE_API_KEY,
    ...overrides,
  };
}

realLog("spawn construction");

{
  const { calls, children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  service.start(CONFIG);

  try {
    await check("spawns pnpm with the exact configured arguments", () => {
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, "pnpm");
      assert.deepEqual(calls[0].args, [
        "exec",
        "pi",
        "-e",
        "builtin:mcp",
        "--provider",
        "custom",
        "--model",
        "my-model-id",
        "--api-key",
        FAKE_API_KEY,
        "--mode",
        "rpc",
        "--append-system-prompt",
        join(PI_AGENT_DIR, "APPEND_SYSTEM.md"),
      ]);
    });

    await check("configured path drops --no-extensions and the Kilo extension", () => {
      const joined = calls[0].args.join(" ");

      assert.ok(!joined.includes("--no-extensions"));
      assert.ok(!joined.includes("kilo"));
      assert.ok(!joined.includes(".ts"), "no extension file should be passed");
      assert.ok(!joined.includes("--extension"));
    });

    await check("points PI_CODING_AGENT_DIR at the app-owned directory", () => {
      const env = calls[0].env as Record<string, string>;

      assert.equal(env.PI_CODING_AGENT_DIR, PI_AGENT_DIR);
      assert.ok(!PI_AGENT_DIR.startsWith(join(homedir(), ".pi")));
    });

    await check("redacted args hide the key while keeping the rest", () => {
      const redacted = redactSpawnArgs(calls[0].args);

      assert.ok(!redacted.includes(FAKE_API_KEY));
      assert.equal(redacted[redacted.indexOf("--api-key") + 1], "***");
      assert.deepEqual(
        redacted.filter((a) => a !== "***"),
        calls[0].args.filter((a) => a !== FAKE_API_KEY),
      );
    });

    await check("browser initialization prompt runs only for a configured start", async () => {
      await sleep(60);

      assert.equal(service.getStatus(), "opening_browser");
    });
  } finally {
    service.stop();

    reapAll(children);
  }
}

realLog("resolution");

await check("resolves a configured runtime", () => {
  const result = resolveRuntimeConfig({
    settings: reader({}),
    piAgentDir: PI_AGENT_DIR,
    cwd: "/work",
  });

  assert.ok(result.ok);

  if (!result.ok) {
    return;
  }

  assert.equal(result.config.providerId, "custom");
  assert.equal(result.config.modelId, "my-model-id");
  assert.equal(result.config.apiKey, FAKE_API_KEY);
  assert.equal(result.config.piAgentDir, PI_AGENT_DIR);
  assert.equal(result.config.cwd, "/work");
  assert.deepEqual(result.provider, {
    baseUrl: "https://gateway.example.com/v1",
    modelId: "my-model-id",
  });
});

await check("buildSpawnArgs/buildSpawnEnv agree with the resolved config", () => {
  const result = resolveRuntimeConfig({
    settings: reader({}),
    piAgentDir: PI_AGENT_DIR,
    cwd: "/work",
  });

  assert.ok(result.ok);

  if (!result.ok) {
    return;
  }

  assert.ok(buildSpawnArgs(result.config).includes("--provider"));
  assert.equal(
    buildSpawnEnv(result.config, { PATH: "/usr/bin" }).PI_CODING_AGENT_DIR,
    PI_AGENT_DIR,
  );
});

await check("refuses to start when nothing is configured", () => {
  const result = resolveRuntimeConfig({
    settings: reader({ hasConfiguredProvider: () => false }),
    piAgentDir: PI_AGENT_DIR,
    cwd: "/work",
  });

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.failure.kind === "setup_required");
});

await check("reports unreadable settings without leaking anything", () => {
  const result = resolveRuntimeConfig({
    settings: reader({
      readProviderSettings: () => {
        throw new SettingsError("unreadable_settings", "Settings file is not valid JSON.");
      },
    }),
    piAgentDir: PI_AGENT_DIR,
    cwd: "/work",
  });

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.failure.kind === "settings_unreadable");

  // A failure code, not prose: whatever the underlying exception said
  // cannot reach the renderer from here.
  assert.ok(!("reason" in result));
});

await check("reports settings that fail validation", () => {
  const result = resolveRuntimeConfig({
    settings: reader({
      readProviderSettings: () => ({ baseUrl: "https://x.test/v1", modelId: "  " }),
    }),
    piAgentDir: PI_AGENT_DIR,
    cwd: "/work",
  });

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.failure.kind === "settings_invalid");
});

await check("reports a key that will not decrypt", () => {
  const result = resolveRuntimeConfig({
    settings: reader({
      readApiKey: () => {
        throw new SettingsError("unreadable_api_key", "Could not decrypt the stored API key: bad decrypt");
      },
    }),
    piAgentDir: PI_AGENT_DIR,
    cwd: "/work",
  });

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.failure.kind === "api_key_unreadable");
});

await check("reports a missing key", () => {
  const result = resolveRuntimeConfig({
    settings: reader({ readApiKey: () => null }),
    piAgentDir: PI_AGENT_DIR,
    cwd: "/work",
  });

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.failure.kind === "api_key_missing");
});

await check("never falls back to a vendor default", () => {
  const unconfigured = resolveRuntimeConfig({
    settings: reader({ hasConfiguredProvider: () => false }),
    piAgentDir: PI_AGENT_DIR,
    cwd: "/work",
  });

  assert.equal(unconfigured.ok, false);

  // Whatever the failure, there is no path that yields a Kilo-ish config.
  const { calls, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  if (!unconfigured.ok) {
    service.failStartup(unconfigured.failure);
  }

  assert.equal(calls.length, 0, "must not spawn on failed resolution");
  assert.equal(service.getStatus(), "error");
});

realLog("process lifecycle");

await check("an old process's exit handler cannot clobber a newer one", async () => {
  // A long startup delay keeps the newer process in "starting" while
  // the superseded one finishes dying, so any status change can only
  // come from the stale handler.
  const { calls, children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  const watch = (child: ChildProcess) =>
    new Promise<void>((resolve) => child.once("exit", () => resolve()));

  service.start(CONFIG);
  const first = children[0];
  const firstExited = watch(first);

  service.stop();
  assert.equal(service.getStatus(), "stopped");

  // Restart before the old process has finished dying.
  service.start(CONFIG);
  assert.equal(calls.length, 2);
  assert.equal(service.getStatus(), "starting");

  // Let the superseded process actually exit now.
  await firstExited;
  await sleep(50);

  assert.equal(
    service.getStatus(),
    "starting",
    "stale exit handler reset the newer process's state",
  );

  service.stop();
  assert.equal(service.getStatus(), "stopped");

  reapAll(children);
});

await check("restart does not leave overlapping processes", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  service.start(CONFIG);
  const first = children[0];

  const firstExited = new Promise<void>((resolve) =>
    first.once("exit", () => resolve()),
  );

  service.stop();
  service.start(CONFIG);
  const second = children[1];

  await firstExited;

  assert.notEqual(first, second);
  assert.equal(service.getStatus(), "starting");

  service.stop();

  reapAll(children);
});

await check("startup timer is cleared on stop", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 40);

  service.start(CONFIG);
  service.stop();

  // Well past the delay: a leaked timer would have fired openBrowser().
  await sleep(120);

  assert.equal(service.getStatus(), "stopped");

  reapAll(children);
});

await check("repeated start() does not spawn a second process", () => {
  const { calls, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  service.start(CONFIG);
  service.start(CONFIG);
  service.start(CONFIG);

  assert.equal(calls.length, 1);

  service.stop();
});

await check("failStartup emits an error without spawning", () => {
  const { calls, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  service.failStartup({ kind: "setup_required" });

  assert.equal(calls.length, 0);
  assert.equal(service.getStatus(), "error");

  // The reason is on the snapshot now, not lost with the event.
  const snapshot = service.getSnapshot();

  assert.equal(snapshot.status, "error");
  assert.ok(snapshot.error && snapshot.error.length > 0);
  assert.ok(snapshot.error!.includes("Setup required"));
});

/*
 * Secret-leak assertions against everything actually logged.
 */
await check("no API key appears in any log output", () => {
  assert.ok(captured.length > 0, "expected the service to have logged something");
  assert.ok(!captured.some((line) => line.includes(FAKE_API_KEY)));
});

await check("no status event carries the API key", () => {
  const { spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  const events: string[] = [];

  service.subscribe((event) => {
    events.push(JSON.stringify(event));
  });

  service.start(CONFIG);
  service.failStartup({ kind: "unknown", message: "synthetic failure" });
  service.stop();

  assert.ok(events.length > 0);
  assert.ok(!events.some((line) => line.includes(FAKE_API_KEY)));
});

realLog("");
realLog(`${passed} checks passed`);
realLog("no real API key read, printed, or persisted");

console.log = realLog;
console.error = realError;
console.error = realError;
