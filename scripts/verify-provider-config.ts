/*
 * Verification for the provider settings and Pi config generator.
 *
 * Run with: pnpm verify:config
 *
 * Dependency-free (no test runner). Exits non-zero on the first failure.
 *
 * Uses only a placeholder credential — never a live one. Nothing reads
 * ~/.pi/agent/auth.json, and the script asserts that file is untouched.
 */

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ProviderSettings } from "../src/shared/types";

import {
  PI_API,
  PI_PROVIDER_ID,
  SettingsError,
  SettingsService,
  type Encryptor,
} from "../src/main/settingsService";
import {
  CHROMIUM_PROFILE_DIR,
  generatePiMcpConfig,
  generatePiModelsConfig,
  piConfigDirForUserData,
  writePiConfig,
} from "../src/main/configGenerator";
import {
  APPEND_SYSTEM_FILE_NAME,
  appendSystemPromptCandidates,
  readAppendSystemPrompt,
} from "../src/main/promptAsset";
import { buildSpawnArgs } from "../src/main/runtimeConfig";

/** Placeholder only. Never a live credential. */
const FAKE_API_KEY = "sk-test-placeholder-not-a-real-key";

const VALID_PROVIDER: ProviderSettings = {
  baseUrl: "https://gateway.example.com/v1",
  modelId: "some-model-id",
};

const realAuthPath = join(homedir(), ".pi", "agent", "auth.json");
const repoRoot = resolve(import.meta.dirname, "..");

let passed = 0;

async function check(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
}

function expectSettingsError(fn: () => void, code: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(
      error instanceof SettingsError,
      `expected SettingsError, got ${String(error)}`,
    );
    assert.equal(error.code, code, `expected code ${code}`);

    // The secret must never travel inside an error message.
    assert.ok(
      !error.message.includes(FAKE_API_KEY),
      "error message leaked the API key",
    );

    return;
  }

  assert.fail("expected a throw");
}

function makeTempUserData(): string {
  return join(
    tmpdir(),
    `agent-browser-config-check-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

/** Deterministic stand-in so this stays Electron-free. */
const fakeEncryptor: Encryptor = {
  available: true,
  encrypt: (plaintext) => Buffer.from(`enc:${plaintext}`, "utf8"),
  decrypt: (buffer) => buffer.toString("utf8").slice("enc:".length),
};

const realAuthFingerprint = existsSync(realAuthPath)
  ? statSync(realAuthPath).mtimeMs
  : null;

console.log("config generation");

await check("valid provider produces the expected Pi provider configuration", () => {
  assert.deepEqual(generatePiModelsConfig(VALID_PROVIDER), {
    providers: {
      [PI_PROVIDER_ID]: {
        baseUrl: VALID_PROVIDER.baseUrl,
        api: PI_API,
        models: [{ id: VALID_PROVIDER.modelId }],
      },
    },
  });
});

await check("generated configuration contains no API key field", () => {
  const serialised = JSON.stringify(generatePiModelsConfig(VALID_PROVIDER));

  assert.ok(!serialised.includes("apiKey"));
  assert.ok(!serialised.includes(FAKE_API_KEY));
});

await check("base URLs are not restricted to a particular vendor or host", () => {
  for (const baseUrl of [
    "https://api.openai.com/v1",
    "http://localhost:8080/v1",
    "https://my-own-gateway.corp.internal/compat/openai",
    "https://192.168.1.44:9000",
  ]) {
    const config = generatePiModelsConfig({ baseUrl, modelId: "m" });

    assert.equal(config.providers[PI_PROVIDER_ID].baseUrl, baseUrl);
  }
});

await check("invalid base URLs are rejected", () => {
  for (const baseUrl of [
    "",
    "   ",
    "not-a-url",
    "/v1/relative",
    "ftp://example.com/v1",
    "file:///etc/passwd",
    "javascript:alert(1)",
  ]) {
    expectSettingsError(
      () => generatePiModelsConfig({ baseUrl, modelId: "m" }),
      "invalid_settings",
    );
  }
});

await check("empty or whitespace model IDs are rejected", () => {
  for (const modelId of ["", "   "]) {
    expectSettingsError(
      () => generatePiModelsConfig({ baseUrl: VALID_PROVIDER.baseUrl, modelId }),
      "invalid_settings",
    );
  }
});

console.log("file placement");

await check("files land in the app-owned dir, not the repo or ~/.pi/agent", () => {
  const userData = makeTempUserData();
  const configDir = writePiConfig(
    piConfigDirForUserData(userData),
    VALID_PROVIDER,
  );

  const written = join(configDir, "models.json");

  assert.ok(existsSync(written), "models.json was not written");
  assert.ok(configDir.startsWith(tmpdir()));
  assert.ok(!written.startsWith(repoRoot), "wrote inside the repo");
  assert.ok(
    !written.startsWith(join(homedir(), ".pi")),
    "wrote into the user's global Pi directory",
  );
});

await check("writing leaves no temporary files behind", () => {
  const configDir = piConfigDirForUserData(makeTempUserData());

  writePiConfig(configDir, VALID_PROVIDER);

  assert.deepEqual(
    readdirSync(configDir).filter((entry) => entry.endsWith(".tmp")),
    [],
  );
});

console.log("settings persistence");

await check("round-trip separates the secret from the non-secret", () => {
  const paths = SettingsService.pathsForUserData(makeTempUserData());
  const service = new SettingsService(paths, fakeEncryptor);

  assert.equal(service.hasConfiguredProvider(), false);
  assert.equal(service.readProviderSettings(), null);

  service.saveProviderSettings(VALID_PROVIDER, FAKE_API_KEY);

  assert.equal(service.hasConfiguredProvider(), true);

  // What a future settings-read IPC would return: no field for a secret.
  assert.deepEqual(service.readProviderSettings(), VALID_PROVIDER);

  // settings.json itself must never carry the key.
  const settingsRaw = readFileSync(paths.settingsPath, "utf8");

  assert.ok(!settingsRaw.includes(FAKE_API_KEY));
  assert.ok(!settingsRaw.toLowerCase().includes("apikey"));

  // Only the dedicated secret accessor can reach it.
  assert.equal(service.readApiKey(), FAKE_API_KEY);
});

await check("hasConfiguredProvider is false when only settings.json exists", () => {
  const paths = SettingsService.pathsForUserData(makeTempUserData());

  new SettingsService(paths, fakeEncryptor).saveProviderSettings(
    VALID_PROVIDER,
    FAKE_API_KEY,
  );

  // Simulate a partial prior state.
  rmSync(paths.apiKeyPath);

  assert.equal(
    new SettingsService(paths, fakeEncryptor).hasConfiguredProvider(),
    false,
  );
});

await check("saving is refused when secure encryption is unavailable", () => {
  const paths = SettingsService.pathsForUserData(makeTempUserData());
  const service = new SettingsService(paths, {
    ...fakeEncryptor,
    available: false,
  });

  expectSettingsError(
    () => service.saveProviderSettings(VALID_PROVIDER, FAKE_API_KEY),
    "encryption_unavailable",
  );

  // Crucially, nothing was persisted in plaintext.
  assert.equal(existsSync(paths.settingsPath), false);
  assert.equal(existsSync(paths.apiKeyPath), false);
});

await check("invalid settings are rejected by the service too", () => {
  const paths = SettingsService.pathsForUserData(makeTempUserData());
  const service = new SettingsService(paths, fakeEncryptor);

  expectSettingsError(
    () => service.saveProviderSettings({ baseUrl: "nope", modelId: "m" }, FAKE_API_KEY),
    "invalid_settings",
  );

  expectSettingsError(
    () => service.saveProviderSettings(VALID_PROVIDER, "   "),
    "invalid_settings",
  );

  assert.equal(existsSync(paths.settingsPath), false);
});

console.log("app-owned mcp.json");

await check("mcp.json is written into the app-owned Pi directory", () => {
  const userData = makeTempUserData();
  const configDir = writePiConfig(
    piConfigDirForUserData(userData),
    VALID_PROVIDER,
  );

  const written = join(configDir, "mcp.json");

  assert.ok(existsSync(written), "mcp.json was not written");
  assert.ok(!written.startsWith(join(homedir(), ".pi")));
  assert.ok(!written.startsWith(repoRoot));
});

await check("mcp.json preserves the Playwright command, args and profile exactly", () => {
  const config = generatePiMcpConfig();

  // Values taken from the repository's .pi/mcp.json — the config Pi
  // actually loads for this app today. Reproduced field for field.
  assert.deepEqual(config, {
    mcpServers: {
      playwright: {
        command: "pnpm",
        args: [
          "exec",
          "playwright-mcp",
          "--user-data-dir",
          "/Users/karpinski94/Library/Application Support/agent-browser/chromium-profile",
        ],
        exposure: "direct",
      },
    },
  });

  const server = config.mcpServers.playwright;

  assert.equal(server.command, "pnpm");
  assert.ok(Array.isArray(server.args));
  assert.ok(server.args.every((arg) => typeof arg === "string"));
  assert.equal(
    server.args[server.args.indexOf("--user-data-dir") + 1],
    CHROMIUM_PROFILE_DIR,
  );
});

await check("generated mcp.json matches the project's working .pi/mcp.json", () => {
  // The strongest available check: .pi/mcp.json is the file Pi loads
  // for this app right now, so an exact structural match proves the
  // configured path keeps identical browser tooling rather than an
  // approximation of it.
  const projectMcp = JSON.parse(
    readFileSync(join(repoRoot, ".pi", "mcp.json"), "utf8"),
  );

  assert.deepEqual(generatePiMcpConfig(), projectMcp);
});

await check("generated mcp.json satisfies Pi's documented server rules", () => {
  const config = generatePiMcpConfig();

  // Mirrors validateMcpServerConfig() from the installed bundle; that
  // function is not part of Pi's public export map, so the rules it
  // enforces are asserted directly.
  const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
  const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"];

  for (const [name, raw] of Object.entries(config.mcpServers)) {
    assert.ok(SERVER_NAME.test(name), `invalid server name "${name}"`);
    assert.ok(
      MCP_EXPOSURES.includes(raw.exposure),
      `invalid exposure "${raw.exposure}"`,
    );
    assert.equal(typeof raw.command, "string");
    assert.ok(
      Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string"),
      "args must be an array of strings",
    );
  }
});

await check("mcp.json carries no secret", () => {
  const configDir = writePiConfig(
    piConfigDirForUserData(makeTempUserData()),
    VALID_PROVIDER,
  );

  const mcpRaw = readFileSync(join(configDir, "mcp.json"), "utf8");
  const modelsRaw = readFileSync(join(configDir, "models.json"), "utf8");

  for (const raw of [mcpRaw, modelsRaw]) {
    assert.ok(!raw.includes(FAKE_API_KEY));
    assert.ok(!raw.toLowerCase().includes("apikey"));
  }
});

console.log("browser-agent instructions");

/**
 * The single canonical, tracked source of the browser-agent
 * instructions. Everything generated is compared against it.
 */
const canonicalPrompt = readFileSync(
  join(repoRoot, ".pi", APPEND_SYSTEM_FILE_NAME),
  "utf8",
);

/** Stands in for a project's own competing instructions. */
const PROJECT_DECOY_PROMPT = "PROJECT DECOY INSTRUCTIONS\n";

await check("APPEND_SYSTEM.md is written into the app-owned Pi directory", () => {
  const configDir = writePiConfig(
    piConfigDirForUserData(makeTempUserData()),
    VALID_PROVIDER,
  );
  const written = join(configDir, APPEND_SYSTEM_FILE_NAME);

  assert.ok(existsSync(written), "APPEND_SYSTEM.md was not written");
  assert.ok(configDir.startsWith(tmpdir()));
  assert.ok(!written.startsWith(repoRoot), "wrote inside the repo");
  assert.ok(
    !written.startsWith(join(homedir(), ".pi")),
    "wrote into the user's global Pi directory",
  );
});

await check("generated instructions match the canonical source byte for byte", () => {
  const configDir = writePiConfig(
    piConfigDirForUserData(makeTempUserData()),
    VALID_PROVIDER,
  );
  const written = readFileSync(join(configDir, APPEND_SYSTEM_FILE_NAME), "utf8");

  // Exact equality rather than a substring check: writePiConfig must
  // reproduce the file as-is, with no added trailing newline and no
  // reformatting.
  assert.equal(written, canonicalPrompt);
  assert.equal(Buffer.byteLength(written), Buffer.byteLength(canonicalPrompt));
});

await check("the instructions carry no credential and no machine-specific path", () => {
  const configDir = writePiConfig(
    piConfigDirForUserData(makeTempUserData()),
    VALID_PROVIDER,
  );
  const written = readFileSync(join(configDir, APPEND_SYSTEM_FILE_NAME), "utf8");

  assert.ok(!written.includes(FAKE_API_KEY));
  assert.ok(!/sk-[A-Za-z0-9]/.test(written));
  assert.ok(!/api[-_ ]?key/i.test(written));
  assert.ok(!/bearer\s/i.test(written));

  // No absolute path of any kind — not the home directory, the repo,
  // the temp dir, or the Chromium profile location.
  assert.ok(!written.includes(homedir()));
  assert.ok(!written.includes(repoRoot));
  assert.ok(!written.includes(tmpdir()));
  assert.ok(!written.includes(CHROMIUM_PROFILE_DIR));
  assert.ok(!written.includes("/Users/"));
});

await check("regenerating picks up a change to the instruction source", () => {
  // Driven through the promptBaseDir seam against a temporary copy of
  // the instructions, so the tracked repository file is never modified.
  const base = makeTempUserData();
  const sourceDir = join(base, ".pi");
  const moduleDir = join(base, "src", "main");
  const configDir = piConfigDirForUserData(makeTempUserData());

  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(moduleDir, { recursive: true });

  writeFileSync(join(sourceDir, APPEND_SYSTEM_FILE_NAME), "first version\n");
  writePiConfig(configDir, VALID_PROVIDER, { promptBaseDir: moduleDir });
  assert.equal(
    readFileSync(join(configDir, APPEND_SYSTEM_FILE_NAME), "utf8"),
    "first version\n",
  );

  writeFileSync(join(sourceDir, APPEND_SYSTEM_FILE_NAME), "second version\n");
  writePiConfig(configDir, VALID_PROVIDER, { promptBaseDir: moduleDir });
  assert.equal(
    readFileSync(join(configDir, APPEND_SYSTEM_FILE_NAME), "utf8"),
    "second version\n",
  );

  // An emitted copy, once present, takes precedence over the source
  // tree — the ordering a packaged app depends on.
  writeFileSync(join(moduleDir, APPEND_SYSTEM_FILE_NAME), "bundled copy\n");
  writePiConfig(configDir, VALID_PROVIDER, { promptBaseDir: moduleDir });
  assert.equal(
    readFileSync(join(configDir, APPEND_SYSTEM_FILE_NAME), "utf8"),
    "bundled copy\n",
  );
});

await check("resolution never reaches for cwd or an assumed repository root", () => {
  // Mirrors the real layouts: in a bundled app baseDir is out/main, so
  // the source-tree candidate resolves back to the repository root.
  const BASE = "/nonexistent/app/out/main";

  assert.deepEqual(appendSystemPromptCandidates(BASE), [
    "/nonexistent/app/out/main/APPEND_SYSTEM.md",
    "/nonexistent/app/.pi/APPEND_SYSTEM.md",
  ]);

  // Neither candidate exists, so resolution fails loudly. Silence would
  // be worse: Pi appends a non-existent --append-system-prompt path
  // literally, as text.
  assert.throws(
    () => readAppendSystemPrompt(BASE),
    /prompt asset is missing/,
  );
});

await check("the build emits the instructions next to the main-process entry", () => {
  const entry = join(repoRoot, "out", "main", "index.js");
  const emitted = join(repoRoot, "out", "main", APPEND_SYSTEM_FILE_NAME);

  if (!existsSync(entry)) {
    console.log("       (build output absent; run pnpm build to check the emitted asset)");
    return;
  }

  assert.ok(existsSync(emitted), "out/main/APPEND_SYSTEM.md was not emitted");
  assert.equal(readFileSync(emitted, "utf8"), canonicalPrompt);
});

await check("the launch arguments name the generated file explicitly", () => {
  const configDir = piConfigDirForUserData(makeTempUserData());

  writePiConfig(configDir, VALID_PROVIDER);

  const args = buildSpawnArgs({
    piAgentDir: configDir,
    providerId: PI_PROVIDER_ID,
    modelId: VALID_PROVIDER.modelId,
    apiKey: FAKE_API_KEY,
    cwd: "/tmp",
  });

  assert.equal(args.filter((arg) => arg === "--append-system-prompt").length, 1);

  const promptPath = args[args.indexOf("--append-system-prompt") + 1];

  assert.equal(promptPath, join(configDir, APPEND_SYSTEM_FILE_NAME));
  assert.ok(promptPath.startsWith("/"), "prompt path must be absolute");
  assert.ok(!promptPath.startsWith(process.cwd()), "must not depend on cwd");
  assert.ok(existsSync(promptPath), "the flag must name a file that exists");

  // Everything preceding the new flag is unchanged.
  assert.deepEqual(args.slice(0, 12), [
    "exec",
    "pi",
    "-e",
    "builtin:mcp",
    "--provider",
    PI_PROVIDER_ID,
    "--model",
    VALID_PROVIDER.modelId,
    "--api-key",
    FAKE_API_KEY,
    "--mode",
    "rpc",
  ]);
});

console.log("Pi loads the app-owned instructions");

/**
 * Build an isolated Pi environment around a freshly generated config.
 *
 * `noExtensions` is essential here: without it the built-in MCP
 * extension reads the generated mcp.json and spawns a real Playwright
 * MCP server, launching a browser. This test needs the resource loader
 * and the system prompt, not tooling.
 *
 * The project directory deliberately contains its own competing
 * instructions, so the trust-precedence edge case is always in play.
 */
async function makePromptHarness(options: {
  projectTrusted: boolean;
  explicitPrompt: boolean;
}): Promise<{
  loader: InstanceType<
    (typeof import("@earendil-works/pi-coding-agent"))["DefaultResourceLoader"]
  >;
  agentDir: string;
  cwd: string;
  promptPath: string;
}> {
  const { DefaultResourceLoader, SettingsManager } = await import(
    "@earendil-works/pi-coding-agent"
  );

  const userData = makeTempUserData();
  const agentDir = writePiConfig(
    piConfigDirForUserData(userData),
    VALID_PROVIDER,
  );
  const cwd = join(userData, "project");

  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", APPEND_SYSTEM_FILE_NAME), PROJECT_DECOY_PROMPT);

  const args = buildSpawnArgs({
    piAgentDir: agentDir,
    providerId: PI_PROVIDER_ID,
    modelId: VALID_PROVIDER.modelId,
    apiKey: FAKE_API_KEY,
    cwd,
  });
  const promptPath = args[args.indexOf("--append-system-prompt") + 1];

  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: options.projectTrusted,
  });

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    ...(options.explicitPrompt
      ? { appendSystemPrompt: [promptPath] }
      : {}),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });

  await loader.reload();

  return { loader, agentDir, cwd, promptPath };
}

await check("a trusted project cannot shadow the app's instructions", async () => {
  const { loader, promptPath } = await makePromptHarness({
    projectTrusted: true,
    explicitPrompt: true,
  });

  // An explicit source suppresses discovery entirely, so there is
  // exactly one entry — never the instructions twice.
  const append = loader.getAppendSystemPrompt();

  assert.equal(append.length, 1);
  assert.equal(append[0], canonicalPrompt);
  assert.ok(
    !append[0].includes(PROJECT_DECOY_PROMPT.trim()),
    "the project's own instructions leaked in",
  );
  assert.deepEqual(loader.getAppendSystemPromptSources(), [
    { path: resolve(promptPath) },
  ]);

  // Pi's built-in system prompt is untouched: no SYSTEM.md was written
  // and --system-prompt was never passed.
  assert.equal(loader.getSystemPrompt(), undefined);
  assert.equal(loader.getSystemPromptSource(), undefined);
});

await check("control: without the flag, a trusted project's instructions win", async () => {
  // Proves the test above is not vacuous. Same environment, but with
  // Pi left to discover the prompt: the project copy takes precedence
  // over the app-owned one, which is exactly the shadowing the
  // --append-system-prompt argument exists to prevent.
  const { loader, cwd } = await makePromptHarness({
    projectTrusted: true,
    explicitPrompt: false,
  });

  const append = loader.getAppendSystemPrompt();

  assert.equal(append.length, 1);
  assert.equal(append[0], PROJECT_DECOY_PROMPT);
  assert.deepEqual(loader.getAppendSystemPromptSources(), [
    { path: resolve(join(cwd, ".pi", APPEND_SYSTEM_FILE_NAME)) },
  ]);
});

await check("control: an untrusted project falls back to the app-owned file", async () => {
  const { loader, promptPath } = await makePromptHarness({
    projectTrusted: false,
    explicitPrompt: false,
  });

  assert.equal(loader.getAppendSystemPrompt()[0], canonicalPrompt);
  assert.deepEqual(loader.getAppendSystemPromptSources(), [
    { path: resolve(promptPath) },
  ]);
});

await check("the instructions reach the system prompt Pi actually builds", async () => {
  const {
    ModelRuntime,
    SessionManager,
    createAgentSession,
  } = await import("@earendil-works/pi-coding-agent");

  const { loader, agentDir, cwd } = await makePromptHarness({
    projectTrusted: true,
    explicitPrompt: true,
  });

  const modelRuntime = await ModelRuntime.create({
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  await modelRuntime.setRuntimeApiKey(PI_PROVIDER_ID, FAKE_API_KEY);

  const model = modelRuntime
    .getModels(PI_PROVIDER_ID)
    .find((entry) => entry.id === VALID_PROVIDER.modelId);

  assert.ok(model, "the generated provider did not resolve a model");

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    // No message is ever sent, so nothing here reaches a model
    // endpoint; the key exists only to satisfy model resolution.
    noTools: "all",
  });

  const systemPrompt = session.systemPrompt;
  const instructions = canonicalPrompt.trim();

  assert.ok(
    systemPrompt.includes(instructions),
    "the browser-agent instructions never reached the system prompt",
  );
  assert.equal(
    systemPrompt.split(instructions).length - 1,
    1,
    "the instructions were appended more than once",
  );
  assert.ok(!systemPrompt.includes(PROJECT_DECOY_PROMPT.trim()));
});

console.log("Pi schema conformance");

await check("Pi's own ModelRuntime accepts the generated models.json", async () => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");

  const configDir = writePiConfig(
    piConfigDirForUserData(makeTempUserData()),
    VALID_PROVIDER,
  );

  const runtime = await ModelRuntime.create({
    modelsPath: join(configDir, "models.json"),
    // Offline and non-refreshing: this asserts local schema
    // conformance, not reachability of the endpoint.
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  const schemaError = runtime.getError();

  assert.equal(
    schemaError,
    undefined,
    `Pi rejected the generated models.json: ${schemaError ?? ""}`,
  );

  // A provider declared only in models.json (no built-in counterpart)
  // must still be registered.
  const provider = runtime.getProvider(PI_PROVIDER_ID);

  assert.ok(provider, "provider was not registered from models.json");
  assert.equal(provider.baseUrl, VALID_PROVIDER.baseUrl);

  const model = runtime
    .getModels(PI_PROVIDER_ID)
    .find((entry) => entry.id === VALID_PROVIDER.modelId);

  assert.ok(model, "configured model did not resolve");
  assert.equal(model.provider, PI_PROVIDER_ID);
  assert.equal(model.api, PI_API);
  assert.equal(model.baseUrl, VALID_PROVIDER.baseUrl);

  // With no key stored anywhere, the provider is (correctly) not yet
  // available — this is what lets the app keep the secret out of
  // models.json without Pi treating the provider as broken.
  const availableBefore = await runtime.getAvailable(PI_PROVIDER_ID);

  assert.equal(availableBefore.length, 0);

  // Injecting the key at runtime — exactly what Pi's --api-key flag
  // does — must make the provider usable, proving the credential never
  // has to be written into models.json or auth.json.
  await runtime.setRuntimeApiKey(PI_PROVIDER_ID, FAKE_API_KEY);

  const availableAfter = await runtime.getAvailable(PI_PROVIDER_ID);

  assert.ok(
    availableAfter.some((entry) => entry.id === VALID_PROVIDER.modelId),
    "runtime API key did not make the provider available",
  );

  // Pi must not have spilled the runtime credential to disk. It lives
  // only in RuntimeCredentials.overrides, an in-memory map.
  const userDataDir = resolve(configDir, "..");

  const offenders = readdirSync(userDataDir, {
    recursive: true,
    encoding: "utf8",
  }).filter((entry) => {
    const full = join(userDataDir, String(entry));

    try {
      return statSync(full).isFile() && readFileSync(full, "utf8").includes(FAKE_API_KEY);
    } catch {
      return false;
    }
  });

  assert.deepEqual(
    offenders,
    [],
    "Pi persisted the runtime API key to disk",
  );
});

await check("Pi rejects a models.json that omits the required providers map", async () => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");

  const configDir = piConfigDirForUserData(makeTempUserData());

  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "models.json"), JSON.stringify({ nope: {} }));

  const runtime = await ModelRuntime.create({
    modelsPath: join(configDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  const error = runtime.getError();

  assert.ok(
    typeof error === "string" && error.length > 0,
    "expected a schema error for a malformed models.json",
  );
});

// The user's real Pi credentials must be untouched.
assert.equal(
  existsSync(realAuthPath) ? statSync(realAuthPath).mtimeMs : null,
  realAuthFingerprint,
  "the real ~/.pi/agent/auth.json was modified",
);

console.log("");
console.log(`${passed} checks passed`);
console.log("real ~/.pi/agent/auth.json untouched");
