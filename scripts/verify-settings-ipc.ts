/*
 * Verification for the settings IPC surface.
 *
 * Run with: pnpm verify:settings
 *
 * Dependency-free. Exercises the main-process SettingsController
 * directly — the layer ipcMain actually calls — so no Electron and no
 * network are involved. Every credential used is a placeholder; no
 * real API key is read, printed or persisted anywhere.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { AgentRuntimeService, type SpawnPi } from "../src/main/agentRuntimeService";
import { piConfigDirForUserData } from "../src/main/configGenerator";
import {
  SettingsController,
  parseSaveSettingsInput,
  scrubSecrets,
} from "../src/main/settingsIpc";
import {
  SettingsService,
  type Encryptor,
} from "../src/main/settingsService";
import type { AgentRuntimeConfig } from "../src/main/runtimeConfig";

/** Placeholders only. Never live credentials. */
const API_KEY = "sk-test-placeholder-not-a-real-key";
const SECOND_API_KEY = "sk-test-placeholder-a-different-key";

const ROOT = join(tmpdir(), `agent-browser-settings-ipc-${process.pid}`);

let passed = 0;

/*
 * Everything the controller logs during these checks is captured so the
 * secret-leak assertions run against real output rather than against
 * an inspection of the source.
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

/**
 * Reversible stand-in for safeStorage.
 *
 * Deliberately not real encryption: the point of these checks is the
 * controller's behaviour, not Electron's keychain.
 */
function fakeEncryptor(available = true): Encryptor {
  return {
    available,
    encrypt: (plaintext) => Buffer.from(`enc:${plaintext}`, "utf8"),
    decrypt: (ciphertext) => {
      const raw = ciphertext.toString("utf8");

      if (!raw.startsWith("enc:")) {
        throw new Error("bad decrypt");
      }

      return raw.slice("enc:".length);
    },
  };
}

type Harness = {
  controller: SettingsController;
  service: SettingsService;
  /** Every config handed to the injected startRuntime, in order. */
  starts: AgentRuntimeConfig[];
  piAgentDir: string;
  settingsPath: string;
  apiKeyPath: string;
};

function makeHarness(name: string, options?: {
  /** When set, startRuntime throws this instead of recording. */
  startThrows?: unknown;
  /** Override where the Pi config is written, to force a write failure. */
  piAgentDir?: string;
}): Harness {
  const userData = join(ROOT, name, "userData");

  mkdirSync(userData, { recursive: true });

  const settingsPaths = SettingsService.pathsForUserData(userData);
  const service = new SettingsService(settingsPaths, fakeEncryptor());
  const starts: AgentRuntimeConfig[] = [];

  const controller = new SettingsController({
    settings: service,
    piAgentDir: options?.piAgentDir ?? piConfigDirForUserData(userData),
    cwd: ROOT,
    startRuntime: (config) => {
      if (options && "startThrows" in options) {
        throw options.startThrows;
      }

      starts.push(config);
    },
  });

  return {
    controller,
    service,
    starts,
    piAgentDir: options?.piAgentDir ?? piConfigDirForUserData(userData),
    settingsPath: settingsPaths.settingsPath,
    apiKeyPath: settingsPaths.apiKeyPath,
  };
}

const VALID_INPUT = {
  baseUrl: "https://gateway.example.com/v1",
  modelId: "test-model",
  apiKey: API_KEY,
};

/* ------------------------------------------------------------------------- *
 * Runtime validation of IPC payloads
 * ------------------------------------------------------------------------- */

realLog("payload validation");

await check("rejects payloads that are not objects", () => {
  for (const bad of [null, undefined, "string", 42, true, ["a"]]) {
    const result = parseSaveSettingsInput(bad);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.code === "invalid_payload");
  }
});

await check("rejects a payload missing a required field", () => {
  for (const bad of [
    { modelId: "m", apiKey: API_KEY },
    { baseUrl: "https://x.test/v1", apiKey: API_KEY },
    {},
  ]) {
    const result = parseSaveSettingsInput(bad);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.field !== undefined);
  }
});

await check("rejects non-string values for each field", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ baseUrl: 7, modelId: "m", apiKey: API_KEY }, "baseUrl"],
    [{ baseUrl: "https://x.test/v1", modelId: {}, apiKey: API_KEY }, "modelId"],
    [{ baseUrl: "https://x.test/v1", modelId: "m", apiKey: ["k"] }, "apiKey"],
    [
      { baseUrl: "https://x.test/v1", modelId: "m", apiKey: { toString: "x" } },
      "apiKey",
    ],
  ];

  for (const [payload, field] of cases) {
    const result = parseSaveSettingsInput(payload);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.field === field);
  }
});

await check("rejects unexpected fields rather than silently dropping them", () => {
  for (const extra of [
    { ...VALID_INPUT, provider: "openai" },
    { ...VALID_INPUT, apiKeyPath: "/etc/passwd" },
    { ...VALID_INPUT, __proto_pollution: true },
  ]) {
    const result = parseSaveSettingsInput(extra);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.code === "unexpected_field");
  }
});

await check("accepts a valid payload and preserves the exact strings", () => {
  const result = parseSaveSettingsInput(VALID_INPUT);

  assert.ok(result.ok);

  if (!result.ok) {
    return;
  }

  assert.equal(result.input.baseUrl, VALID_INPUT.baseUrl);
  assert.equal(result.input.modelId, VALID_INPUT.modelId);
  assert.equal(result.input.apiKey, API_KEY);
});

await check("treats an omitted, null or blank apiKey as keep-the-stored-key", () => {
  for (const apiKey of [undefined, null, "", "   "]) {
    const result = parseSaveSettingsInput({
      baseUrl: "https://x.test/v1",
      modelId: "m",
      apiKey,
    });

    assert.ok(result.ok);
  }
});

/* ------------------------------------------------------------------------- *
 * Scrubbing
 * ------------------------------------------------------------------------- */

realLog("secret scrubbing");

await check("removes a submitted secret from a message", () => {
  assert.equal(
    scrubSecrets(`failed for ${API_KEY} while connecting`, [API_KEY]),
    "failed for [redacted] while connecting",
  );
});

await check("leaves short placeholders alone rather than mangling text", () => {
  assert.equal(scrubSecrets("an error occurred", ["ab"]), "an error occurred");
});

/* ------------------------------------------------------------------------- *
 * First launch
 * ------------------------------------------------------------------------- */

realLog("first launch");

await check("reports an unconfigured app without inventing defaults", () => {
  const harness = makeHarness("first-launch");
  const snapshot = harness.controller.getSnapshot();

  assert.equal(snapshot.isConfigured, false);
  assert.equal(snapshot.hasStoredApiKey, false);
  assert.equal(snapshot.provider, null);
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "hasStoredApiKey",
    "isConfigured",
    "provider",
  ]);
});

await check("refuses to start the runtime when nothing is configured", () => {
  const harness = makeHarness("first-launch-start");
  const attempt = harness.controller.startFromStoredSettings();

  assert.equal(attempt.ok, false);
  assert.ok(!attempt.ok && attempt.failure.kind === "setup_required");
  assert.equal(harness.starts.length, 0);
});

await check("a settings file with no key is still not a usable configuration", () => {
  const harness = makeHarness("partial-config");

  writeFileSync(
    harness.settingsPath,
    `${JSON.stringify(
      {
        version: 1,
        provider: { baseUrl: "https://x.test/v1", modelId: "m" },
      },
      null,
      2,
    )}\n`,
  );

  const snapshot = harness.controller.getSnapshot();

  assert.equal(snapshot.provider?.baseUrl, "https://x.test/v1");
  assert.equal(snapshot.hasStoredApiKey, false);
  assert.equal(snapshot.isConfigured, false);
  assert.equal(harness.controller.startFromStoredSettings().ok, false);
});

await check("a blank first-launch save is rejected and writes nothing", () => {
  const harness = makeHarness("first-launch-blank");
  const result = harness.controller.save({
    baseUrl: "https://x.test/v1",
    modelId: "m",
    apiKey: "",
  });

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.field === "apiKey");
  assert.equal(harness.starts.length, 0);
  assert.equal(harness.controller.getSnapshot().isConfigured, false);
});

/* ------------------------------------------------------------------------- *
 * Save -> config generation -> startup
 * ------------------------------------------------------------------------- */

realLog("save and startup");

await check("a save persists, generates Pi config and starts the runtime", () => {
  const harness = makeHarness("save-flow");
  const result = harness.controller.save(VALID_INPUT);

  assert.ok(result.ok);

  if (!result.ok) {
    return;
  }

  assert.equal(result.settings.isConfigured, true);
  assert.equal(result.settings.provider?.baseUrl, VALID_INPUT.baseUrl);
  assert.equal(result.settings.provider?.modelId, VALID_INPUT.modelId);

  assert.equal(harness.starts.length, 1);
  assert.equal(harness.starts[0].modelId, VALID_INPUT.modelId);
  assert.equal(harness.starts[0].apiKey, API_KEY);

  const models = JSON.parse(
    readFileSync(join(harness.piAgentDir, "models.json"), "utf8"),
  );

  assert.equal(
    models.providers.custom.baseUrl,
    VALID_INPUT.baseUrl,
  );
  assert.equal(models.providers.custom.models[0].id, VALID_INPUT.modelId);
  assert.ok(!JSON.stringify(models).includes(API_KEY));

  assert.ok(
    readFileSync(join(harness.piAgentDir, "mcp.json"), "utf8").includes(
      "playwright",
    ),
  );
});

await check("saving again restarts the runtime with the new configuration", async () => {
  const harness = makeHarness("save-restart");

  assert.ok(harness.controller.save(VALID_INPUT).ok);
  assert.equal(harness.starts.length, 1);

  const second = harness.controller.save({
    baseUrl: "https://other.example.com/v1",
    modelId: "other-model",
    apiKey: SECOND_API_KEY,
  });

  assert.ok(second.ok);
  assert.equal(harness.starts.length, 2);
  assert.equal(harness.starts[1].modelId, "other-model");
  assert.equal(harness.starts[1].apiKey, SECOND_API_KEY);
  assert.notEqual(harness.starts[0].apiKey, harness.starts[1].apiKey);

  await sleep(0);
});

/* ------------------------------------------------------------------------- *
 * Read responses never expose the key
 * ------------------------------------------------------------------------- */

realLog("secret exposure");

await check("settings:get never returns the API key", () => {
  const harness = makeHarness("read-secret");

  assert.ok(harness.controller.save(VALID_INPUT).ok);

  const snapshot = harness.controller.getSnapshot();
  const serialised = JSON.stringify(snapshot);

  assert.ok(!serialised.includes(API_KEY));
  assert.equal("apiKey" in snapshot, false);

  // hasStoredApiKey is a boolean; no field anywhere may hold key text.
  const keys: string[] = [];

  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      assert.ok(!value.includes(API_KEY));
    } else if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        keys.push(key);
        walk(nested);
      }
    }
  };

  walk(snapshot);

  assert.ok(!keys.includes("apiKey"));
  assert.deepEqual(keys.sort(), ["baseUrl", "hasStoredApiKey", "isConfigured", "modelId", "provider"]);
});

await check("settings.json on disk holds no key material", () => {
  const harness = makeHarness("read-secret-disk");

  assert.ok(harness.controller.save(VALID_INPUT).ok);

  const onDisk = readFileSync(harness.settingsPath, "utf8");

  assert.ok(!onDisk.includes(API_KEY));
  assert.ok(!onDisk.includes("apiKey"));
});

/* ------------------------------------------------------------------------- *
 * Blank key preserves the stored key
 * ------------------------------------------------------------------------- */

realLog("key preservation");

await check("a blank key keeps the stored ciphertext byte-for-byte", () => {
  const harness = makeHarness("preserve-key");

  assert.ok(harness.controller.save(VALID_INPUT).ok);

  const before = readFileSync(harness.apiKeyPath, "utf8");

  const result = harness.controller.save({
    baseUrl: "https://changed.example.com/v2",
    modelId: "changed-model",
    apiKey: "   ",
  });

  assert.ok(result.ok);
  assert.equal(readFileSync(harness.apiKeyPath, "utf8"), before);
  assert.equal(harness.service.readApiKey(), API_KEY);
  assert.equal(
    result.ok && result.settings.provider?.baseUrl,
    "https://changed.example.com/v2",
  );
  assert.equal(result.ok && result.settings.provider?.modelId, "changed-model");
  assert.equal(harness.starts.length, 2);
  assert.equal(harness.starts[1].apiKey, API_KEY);

  // The Base URL change must reach the generated Pi config too, not
  // just settings.json.
  const models = JSON.parse(
    readFileSync(join(harness.piAgentDir, "models.json"), "utf8"),
  );

  assert.equal(models.providers.custom.baseUrl, "https://changed.example.com/v2");
  assert.equal(models.providers.custom.models[0].id, "changed-model");
});

await check("an omitted key behaves exactly like a blank one", () => {
  const harness = makeHarness("preserve-key-omitted");

  assert.ok(harness.controller.save(VALID_INPUT).ok);

  const before = readFileSync(harness.apiKeyPath, "utf8");

  const result = harness.controller.save({
    baseUrl: "https://changed.example.com/v2",
    modelId: "changed-model",
  });

  assert.ok(result.ok);
  assert.equal(readFileSync(harness.apiKeyPath, "utf8"), before);
});

await check("a new key does replace the stored one", () => {
  const harness = makeHarness("replace-key");

  assert.ok(harness.controller.save(VALID_INPUT).ok);
  assert.ok(
    harness.controller.save({
      baseUrl: VALID_INPUT.baseUrl,
      modelId: VALID_INPUT.modelId,
      apiKey: SECOND_API_KEY,
    }).ok,
  );

  assert.equal(harness.service.readApiKey(), SECOND_API_KEY);
  assert.notEqual(harness.starts[1].apiKey, harness.starts[0].apiKey);
});

await check("the snapshot reports whether a key is stored, without revealing it", () => {
  const harness = makeHarness("snapshot-has-key");

  assert.equal(harness.controller.getSnapshot().hasStoredApiKey, false);

  assert.ok(harness.controller.save(VALID_INPUT).ok);

  const snapshot = harness.controller.getSnapshot();

  assert.equal(snapshot.hasStoredApiKey, true);
  assert.equal(snapshot.isConfigured, true);
  assert.ok(!JSON.stringify(snapshot).includes(API_KEY));
});

/* ------------------------------------------------------------------------- *
 * Failures leave the previous configuration intact
 * ------------------------------------------------------------------------- */

realLog("failure isolation");

await check("an invalid save leaves the working configuration untouched", () => {
  const harness = makeHarness("failure-invalid");

  assert.ok(harness.controller.save(VALID_INPUT).ok);

  const settingsBefore = readFileSync(harness.settingsPath, "utf8");
  const keyBefore = readFileSync(harness.apiKeyPath, "utf8");

  const result = harness.controller.save({
    baseUrl: "not-a-url",
    modelId: "m",
    apiKey: SECOND_API_KEY,
  });

  assert.equal(result.ok, false);
  assert.equal(readFileSync(harness.settingsPath, "utf8"), settingsBefore);
  assert.equal(readFileSync(harness.apiKeyPath, "utf8"), keyBefore);
  assert.equal(harness.service.readApiKey(), API_KEY);
  assert.equal(harness.starts.length, 1);
});

await check("a Pi config write failure reports an error and does not restart", () => {
  // A regular file where a directory is expected makes the atomic write
  // fail deterministically, without touching permissions.
  const blocker = join(ROOT, "blocked");
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(blocker, "not a directory");

  const harness = makeHarness("failure-config-write", {
    piAgentDir: join(blocker, "pi-config"),
  });

  const result = harness.controller.save(VALID_INPUT);

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.code === "config_write_failed");
  assert.equal(harness.starts.length, 0);
});

await check("a startup failure is reported and the secret is not echoed", () => {
  const harness = makeHarness("failure-start", {
    // Worst case: the thrown message quotes the credential it was given.
    startThrows: new Error(`spawn failed for ${API_KEY}`),
  });

  const result = harness.controller.save(VALID_INPUT);

  assert.equal(result.ok, false);
  assert.ok(!result.ok);

  // Neither the key nor the raw exception text reaches the renderer:
  // the controller reports a stable code and the summariser renders a
  // fixed message from it.
  assert.ok(!JSON.stringify(result).includes(API_KEY));
  assert.ok(!result.ok && !result.error.message.includes("spawn failed"));
  assert.ok(!result.ok && result.error.code === "start_failed");
  assert.ok(!result.ok && result.error.message.length > 0);
});

await check("encryption being unavailable writes nothing", () => {
  const userData = join(ROOT, "no-encryption", "userData");
  mkdirSync(userData, { recursive: true });

  const paths = SettingsService.pathsForUserData(userData);
  const service = new SettingsService(paths, fakeEncryptor(false));
  const piAgentDir = piConfigDirForUserData(userData);
  const starts: AgentRuntimeConfig[] = [];

  const controller = new SettingsController({
    settings: service,
    piAgentDir,
    cwd: ROOT,
    startRuntime: (config) => starts.push(config),
  });

  const result = controller.save(VALID_INPUT);

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.code === "encryption_unavailable");
  assert.equal(starts.length, 0);
  assert.equal(controller.getSnapshot().isConfigured, false);
});

/* ------------------------------------------------------------------------- *
 * End to end: no overlapping Pi processes across a restart
 * ------------------------------------------------------------------------- */

realLog("runtime lifecycle through settings");

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

/** A real, harmless long-lived child so live-process counting is honest. */
function spawnStandstill(): ChildProcess {
  return spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
}

await check("saving a new model never leaves two Pi processes alive", async () => {
  const harness = makeHarness("no-overlap");

  const live: ChildProcess[] = [];
  const spawnPi: SpawnPi = () => {
    const child = spawnStandstill();

    live.push(child);
    allChildren.push(child);

    return child as never;
  };

  const service = new AgentRuntimeService(spawnPi, 20);
  const controller = new SettingsController({
    settings: harness.service,
    piAgentDir: harness.piAgentDir,
    cwd: ROOT,
    startRuntime: (config) => service.restart(config),
  });

  const alive = () =>
    live.filter((c) => c.exitCode === null && c.signalCode === null).length;

  try {
    assert.ok(controller.save(VALID_INPUT).ok);
    assert.equal(live.length, 1);
    assert.equal(alive(), 1);

    const firstExited = new Promise<void>((resolve) =>
      live[0].once("exit", () => resolve()),
    );

    const second = controller.save({
      baseUrl: "https://other.example.com/v1",
      modelId: "other-model",
      apiKey: SECOND_API_KEY,
    });

    assert.ok(second.ok);
    assert.equal(live.length, 2);

    // Wait for the superseded child: if the swap leaked, it would still
    // be running here.
    await firstExited;
    await sleep(20);

    assert.equal(alive(), 1, "an old Pi process outlived the restart");
    assert.notEqual(live[0], live[1]);
  } finally {
    service.stop();

    for (const child of live) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

await check("a stale exit cannot disturb the runtime started by a later save", async () => {
  const harness = makeHarness("stale-exit");

  const live: ChildProcess[] = [];
  const spawnPi: SpawnPi = () => {
    const child = spawnStandstill();

    live.push(child);
    allChildren.push(child);

    return child as never;
  };

  // Long enough that the fresh process is still starting when the old
  // one finishes dying.
  const service = new AgentRuntimeService(spawnPi, 60_000);
  const controller = new SettingsController({
    settings: harness.service,
    piAgentDir: harness.piAgentDir,
    cwd: ROOT,
    startRuntime: (config) => service.restart(config),
  });

  try {
    assert.ok(controller.save(VALID_INPUT).ok);

    const firstExited = new Promise<void>((resolve) =>
      live[0].once("exit", () => resolve()),
    );

    assert.ok(
      controller.save({
        baseUrl: "https://other.example.com/v1",
        modelId: "other-model",
        apiKey: SECOND_API_KEY,
      }).ok,
    );

    await firstExited;
    await sleep(30);

    assert.equal(
      service.getStatus(),
      "starting",
      "a superseded process's exit event changed the current status",
    );
  } finally {
    service.stop();

    for (const child of live) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

/* ------------------------------------------------------------------------- *
 * Whole-run secret assertions
 * ------------------------------------------------------------------------- */

await check("no API key reached the logs during any of the above", () => {
  assert.ok(!captured.some((line) => line.includes(API_KEY)));
  assert.ok(!captured.some((line) => line.includes(SECOND_API_KEY)));
});

rmSync(ROOT, { recursive: true, force: true });

console.log = realLog;
console.error = realError;

realLog("");
realLog(`${passed} checks passed`);
realLog("no real API key read, printed, or persisted");
