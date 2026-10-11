import { join } from "node:path";

import type { ProviderSettings } from "../shared/types";

import { writeFileAtomic } from "./fsAtomic";
import {
  APPEND_SYSTEM_FILE_NAME,
  readAppendSystemPrompt,
} from "./promptAsset";
import {
  PI_API,
  PI_PROVIDER_ID,
  validateProviderSettings,
} from "./settingsService";

/**
 * Application-owned Pi configuration directory.
 *
 * Pi resolves its whole agent dir from $PI_CODING_AGENT_DIR (verified:
 * getAgentDir() reads process.env.PI_CODING_AGENT_DIR, falling back to
 * ~/.pi/agent). Pointing it here keeps the app's generated config out
 * of the user's global Pi state.
 *
 * This redirect moves *all* of Pi's agent-dir-relative config, not just
 * models.json: auth.json, settings.json, sessions/ and — critically —
 * mcp.json, which loadMcpConfig() reads from join(agentDir, "mcp.json").
 * Without re-declaring the Playwright server here, pointing Pi at this
 * directory would silently drop the browser tooling the app depends on.
 * That is why writePiConfig() emits mcp.json alongside models.json.
 */
export const PI_CONFIG_DIR_NAME = "pi-config";

export function piConfigDirForUserData(userDataDir: string): string {
  return join(userDataDir, PI_CONFIG_DIR_NAME);
}

export const PI_MODELS_FILE_NAME = "models.json";

export const PI_MCP_FILE_NAME = "mcp.json";

/**
 * Subset of Pi's ProviderConfigSchema this app writes.
 *
 * Mirrored from the installed package rather than guessed. Every field
 * below is Optional in Pi's schema; `models` entries require only `id`.
 */
export type PiProviderConfig = {
  baseUrl: string;
  api: string;
  models: Array<{ id: string }>;
};

/** Matches Pi's ModelsConfigSchema: `providers` is the only key. */
export type PiModelsConfig = {
  providers: Record<string, PiProviderConfig>;
};

/**
 * Build the models.json contents for a provider configuration.
 *
 * Shape verified against the installed Pi bundle:
 *
 *   ModelsConfigSchema = { providers: Record<String, ProviderConfigSchema> }
 *   ProviderConfigSchema = { name?, baseUrl?, apiKey?, api?, oauth?,
 *                            headers?, compat?, authHeader?, models?,
 *                            modelOverrides? }
 *   ModelDefinitionSchema = { id (required), name?, api?, baseUrl?, ... }
 *
 * Two runtime rules, beyond the schema, also have to hold:
 *
 *   1. A provider must declare at least one of baseUrl / headers /
 *      compat / modelOverrides / apiKey / oauth / authHeader / models,
 *      otherwise applyModelsJson throws. Declaring both `baseUrl` and
 *      `models` satisfies that.
 *
 *   2. `api` resolves as model.api ?? provider.api ?? defaults.api, and
 *      `baseUrl` as model.baseUrl ?? provider.baseUrl ?? defaults.baseUrl.
 *      With no built-in counterpart for this provider id there are no
 *      defaults, so both are supplied at the provider level. Pi accepts
 *      provider-level `api` for chat models.
 *
 * The API key is intentionally absent. It is passed at launch via Pi's
 * --api-key flag, which stores it only in an in-memory
 * RuntimeCredentials override and never writes it to disk. The
 * alternatives were both worse: models.json `apiKey` and auth.json hold
 * the key as plaintext JSON, and Pi's env-var credential lookup uses a
 * hardcoded provider-name map with no generic fallback, so it cannot
 * serve an arbitrary provider id.
 */
export function generatePiModelsConfig(
  provider: ProviderSettings,
): PiModelsConfig {
  validateProviderSettings(provider);

  return {
    providers: {
      [PI_PROVIDER_ID]: {
        baseUrl: provider.baseUrl.trim(),
        api: PI_API,
        models: [{ id: provider.modelId.trim() }],
      },
    },
  };
}

/**
 * Write the application-owned Pi configuration directory.
 *
 * Emits models.json, mcp.json and APPEND_SYSTEM.md. All three are
 * required for the redirect to be safe: models.json supplies the
 * provider, mcp.json keeps the browser tooling available once
 * PI_CODING_AGENT_DIR moves MCP discovery out of ~/.pi/agent, and
 * APPEND_SYSTEM.md supplies the browser-agent instructions.
 *
 * APPEND_SYSTEM.md is deliberately written here, into the app-owned
 * directory, for two independent reasons:
 *
 *   1. The app redirects PI_CODING_AGENT_DIR to this directory, so any
 *      file Pi looks for in its agent dir has to be produced here or it
 *      does not exist at all.
 *
 *   2. A project-level <cwd>/.pi/APPEND_SYSTEM.md is trust-gated. The
 *      app launches Pi in --mode rpc, where Pi cannot render a prompt,
 *      and with the default projectTrust of "ask" no trust decision is
 *      ever resolved, so Pi skips the project copy. Worse, if the
 *      project *were* trusted, the project copy takes precedence over
 *      the agent-dir copy and would silently replace the app's
 *      instructions. Writing the file here and pointing
 *      --append-system-prompt at it (see buildSpawnArgs) makes the
 *      source explicit and immune to that precedence.
 *
 * The contents are preserved exactly, with no trailing newline added:
 * Pi reads this file as-is and the verification scripts assert
 * byte-equality against the canonical source.
 *
 * Returns the directory written to. Creates it if needed and writes
 * each file atomically.
 */
export function writePiConfig(
  configDirectory: string,
  provider: ProviderSettings,
  options?: {
    /**
     * Base directory used to resolve the canonical instructions.
     *
     * An explicit seam for the verification scripts, which exercise
     * regeneration against a temporary copy of the instructions rather
     * than the tracked repository file. Production callers omit it and
     * get the bundled asset.
     */
    promptBaseDir?: string;
  },
): string {
  const models = generatePiModelsConfig(provider);

  writeFileAtomic(
    join(configDirectory, PI_MODELS_FILE_NAME),
    `${JSON.stringify(models, null, 2)}\n`,
  );

  writeFileAtomic(
    join(configDirectory, PI_MCP_FILE_NAME),
    `${JSON.stringify(generatePiMcpConfig(), null, 2)}\n`,
  );

  writeFileAtomic(
    join(configDirectory, APPEND_SYSTEM_FILE_NAME),
    readAppendSystemPrompt(options?.promptBaseDir),
  );

  return configDirectory;
}

/**
 * Directory the headed Chromium instance keeps its profile in.
 *
 * Preserved verbatim from the repository's existing .pi/mcp.json so the
 * configured runtime keeps the same persistent login/session state the
 * app has used so far. It is an absolute, machine-specific path — a
 * pre-existing wart inherited deliberately rather than silently changed
 * here. Making it app-relative belongs in a later cleanup step.
 */
export const CHROMIUM_PROFILE_DIR =
  "/Users/karpinski94/Library/Application Support/agent-browser/chromium-profile";

export const PLAYWRIGHT_MCP_SERVER_NAME = "playwright";

export const PLAYWRIGHT_MCP_COMMAND = "pnpm";

export const PLAYWRIGHT_MCP_ARGS = [
  "exec",
  "playwright-mcp",
  "--user-data-dir",
  CHROMIUM_PROFILE_DIR,
] as const;

/**
 * "direct" makes the server's tools callable in the normal tool
 * namespace rather than deferred behind codemode.
 */
export const PLAYWRIGHT_MCP_EXPOSURE = "direct";

/** Subset of Pi's stdio MCP server config this app writes. */
export type PiMcpServerConfig = {
  command: string;
  args: string[];
  exposure: string;
};

/** Matches the shape Pi's readConfigFile() expects. */
export type PiMcpConfig = {
  mcpServers: Record<string, PiMcpServerConfig>;
};

/**
 * Build the mcp.json contents.
 *
 * Reproduces the server the app already relies on, taken from the
 * repository's .pi/mcp.json rather than guessed. Field names and values
 * were checked against Pi's validateMcpServerConfig(): "playwright"
 * matches SERVER_NAME (/^[A-Za-z0-9_-]+$/), "direct" is a member of
 * MCP_EXPOSURES, and a string command with a string[] args is a valid
 * stdio server.
 *
 * Deliberately only this one server: the app's global ~/.pi/agent has
 * no mcp.json of its own, and the intent is not to import the user's
 * wider Pi configuration into app-owned state.
 */
export function generatePiMcpConfig(): PiMcpConfig {
  return {
    mcpServers: {
      [PLAYWRIGHT_MCP_SERVER_NAME]: {
        command: PLAYWRIGHT_MCP_COMMAND,
        args: [...PLAYWRIGHT_MCP_ARGS],
        exposure: PLAYWRIGHT_MCP_EXPOSURE,
      },
    },
  };
}
