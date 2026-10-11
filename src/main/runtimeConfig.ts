import { join } from "node:path";

import type { ProviderSettings } from "../shared/types";

import { APPEND_SYSTEM_FILE_NAME } from "./promptAsset";
import {
  PI_PROVIDER_ID,
  SettingsError,
  validateProviderSettings,
} from "./settingsService";
import type { RuntimeFailure } from "./summarizeRuntimeError";

/**
 * Fully resolved parameters for one Pi launch.
 *
 * Lives in the main process only. `apiKey` is the decrypted secret: it
 * must never be placed in shared types, sent over IPC, written to any
 * config file, or logged. Use redactSpawnArgs() before logging.
 */
export type AgentRuntimeConfig = {
  /** Directory to publish as PI_CODING_AGENT_DIR. */
  piAgentDir: string;

  /** Pi provider id; "custom" for the generated generic provider. */
  providerId: string;

  /** Model id exactly as configured by the user. */
  modelId: string;

  /** Decrypted API key. Secret. Main process only. */
  apiKey: string;

  /** Working directory for the Pi process. */
  cwd: string;
};

/**
 * The subset of SettingsService this module needs.
 *
 * Declared structurally so resolution logic stays free of both Electron
 * and the concrete settings implementation.
 */
export type ProviderSettingsReader = {
  hasConfiguredProvider(): boolean;
  readProviderSettings(): ProviderSettings | null;
  readApiKey(): string | null;
};

export type RuntimeResolution =
  | {
      ok: true;
      config: AgentRuntimeConfig;
      provider: ProviderSettings;
    }
  | {
      ok: false;
      /**
       * Stable failure code rather than prose.
       *
       * A raw exception message cannot be trusted here: it may quote the
       * command line (which carries the API key), a filesystem path or a
       * third-party payload. Callers pass this to
       * summarizeRuntimeError(), which turns it into a short safe
       * message. That is what lets an IPC handler avoid ever forwarding
       * arbitrary text into a runtime event.
       */
      failure: RuntimeFailure;
    };

/**
 * Decide whether a configured runtime can start, and build its config.
 *
 * Never guesses. With no settings, unreadable settings, or a key that
 * will not decrypt, it returns a failure code instead of falling back
 * to any built-in provider — there is no Kilo path and no default model
 * here.
 */
export function resolveRuntimeConfig(options: {
  settings: ProviderSettingsReader;
  piAgentDir: string;
  cwd: string;
}): RuntimeResolution {
  const { settings, piAgentDir, cwd } = options;

  if (!settings.hasConfiguredProvider()) {
    return { ok: false, failure: { kind: "setup_required" } };
  }

  let provider: ProviderSettings | null;

  try {
    provider = settings.readProviderSettings();
  } catch (error) {
    return { ok: false, failure: settingsReadFailure(error) };
  }

  if (!provider) {
    return { ok: false, failure: { kind: "setup_required" } };
  }

  try {
    // Guards against a settings.json edited by hand into a state the
    // app could not have written, e.g. an empty model ID.
    validateProviderSettings(provider);
  } catch (error) {
    return { ok: false, failure: invalidSettingsFailure(error) };
  }

  let apiKey: string | null;

  try {
    apiKey = settings.readApiKey();
  } catch (error) {
    return { ok: false, failure: apiKeyFailureOf(error) };
  }

  if (!apiKey) {
    return { ok: false, failure: { kind: "api_key_missing" } };
  }

  return {
    ok: true,
    provider: {
      baseUrl: provider.baseUrl.trim(),
      modelId: provider.modelId.trim(),
    },
    config: {
      piAgentDir,
      providerId: PI_PROVIDER_ID,
      modelId: provider.modelId.trim(),
      apiKey,
      cwd,
    },
  };
}

/*
 * Exception -> failure code.
 *
 * Only SettingsError is translated, because its messages are authored
 * by this app and its `code` is a stable contract. Anything else keeps
 * its message but is marked untrusted, so summarizeRuntimeError() will
 * classify or discard it rather than display it.
 *
 * Exported because the settings controller needs the same translation
 * when it decides whether a stored configuration is launchable at all.
 */
export function settingsReadFailure(error: unknown): RuntimeFailure {
  if (error instanceof SettingsError) {
    switch (error.code) {
      case "unreadable_settings":
        return { kind: "settings_unreadable" };
      case "invalid_settings":
        return invalidSettingsFailure(error);
      default:
        // unreadable_api_key / encryption_unavailable surfacing through
        // a provider read are still "we could not read what is stored".
        return { kind: "settings_unreadable" };
    }
  }

  return { kind: "unknown", message: describe(error), trusted: false };
}

export function invalidSettingsFailure(error: unknown): RuntimeFailure {
  if (error instanceof SettingsError) {
    return {
      kind: "settings_invalid",
      ...(error.field ? { field: error.field } : {}),
      // Authored by validateProviderSettings(); safe to summarise.
      message: error.message,
    };
  }

  return { kind: "settings_invalid" };
}

function apiKeyFailureOf(error: unknown): RuntimeFailure {
  if (error instanceof SettingsError && error.code === "unreadable_api_key") {
    return { kind: "api_key_unreadable" };
  }

  return { kind: "unknown", message: describe(error), trusted: false };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Arguments passed to `pnpm`.
 *
 * The configured path deliberately carries no --no-extensions flag and
 * no vendor extension: the generic openai-completions provider needs
 * neither. builtin:mcp is loaded explicitly so the generated mcp.json
 * is actually consulted.
 *
 * --api-key is Pi's supported in-memory credential mechanism; it never
 * writes the key to models.json or auth.json.
 *
 * --append-system-prompt names the app-owned instruction file by
 * absolute path rather than leaving Pi to discover one. Passing a path
 * is not passing file contents: Pi reads the file itself.
 *
 * It is passed explicitly because discovery is not safe enough here. A
 * project-level <cwd>/.pi/APPEND_SYSTEM.md is trust-gated, and in
 * --mode rpc the default "ask" policy never resolves a prompt, so the
 * project copy is skipped. But if the project *were* trusted, that copy
 * takes precedence over the agent-dir copy and would silently replace
 * the app's browser-agent instructions. An explicit source removes the
 * precedence question entirely.
 *
 * This cannot duplicate the instructions either. Pi's resource loader
 * treats a present appendSystemPromptSource as authoritative and skips
 * discovery, so the file is read once through this flag and never a
 * second time from the agent directory.
 *
 * The file must exist by the time Pi starts: Pi appends a non-existent
 * path *literally*, as text. writePiConfig() always produces it before
 * resolveRuntimeConfig()/startRuntime() run, and a failure to do so
 * surfaces as config_write_failed without ever spawning a process.
 */
export function buildSpawnArgs(config: AgentRuntimeConfig): string[] {
  return [
    "exec",
    "pi",
    "-e",
    "builtin:mcp",
    "--provider",
    config.providerId,
    "--model",
    config.modelId,
    "--api-key",
    config.apiKey,
    "--mode",
    "rpc",
    "--append-system-prompt",
    join(config.piAgentDir, APPEND_SYSTEM_FILE_NAME),
  ];
}

/**
 * Environment for the Pi process.
 *
 * PI_CODING_AGENT_DIR is the switch that moves Pi's entire config to
 * the app-owned directory. Passing a base keeps normal PATH etc. intact
 * so `pnpm exec pi` still resolves.
 */
export function buildSpawnEnv(
  config: AgentRuntimeConfig,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    PI_CODING_AGENT_DIR: config.piAgentDir,
  };
}

/**
 * Copy of the spawn arguments safe to log.
 *
 * The real arguments contain the API key as the value after --api-key,
 * so they must never be logged directly. This replaces just that value,
 * leaving the rest intact for debugging.
 */
export function redactSpawnArgs(args: readonly string[]): string[] {
  const copy = [...args];
  const index = copy.indexOf("--api-key");

  if (index !== -1 && index + 1 < copy.length) {
    copy[index + 1] = "***";
  }

  return copy;
}
