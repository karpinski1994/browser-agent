import type {
  ProviderSettings,
  SaveSettingsInput,
  SettingsError,
  SettingsField,
  SettingsSaveResult,
  SettingsSnapshot,
} from "../shared/types";

import { writePiConfig } from "./configGenerator";
import {
  invalidSettingsFailure,
  resolveRuntimeConfig,
  settingsReadFailure,
  type AgentRuntimeConfig,
} from "./runtimeConfig";
import {
  SettingsError as SettingsServiceError,
  SettingsService,
  validateProviderSettings,
} from "./settingsService";
import {
  summarizeRuntimeError,
  type RuntimeFailure,
} from "./summarizeRuntimeError";

/**
 * Fields a save payload may contain.
 *
 * Anything else is rejected rather than ignored, so a typo or an
 * injected property cannot be silently dropped.
 */
const ALLOWED_FIELDS = new Set(["baseUrl", "modelId", "apiKey"]);

/**
 * Failure a start attempt reports.
 *
 * A stable code rather than prose: the raw exception text must never
 * reach a runtime event, and the renderer turns these into short safe
 * messages via summarizeRuntimeError().
 */
export type StartAttempt = { ok: true } | { ok: false; failure: RuntimeFailure };

export type SettingsControllerDeps = {
  settings: SettingsService;

  /** Application-owned Pi config directory. */
  piAgentDir: string;

  cwd: string;

  /**
   * Starts (or restarts) the agent runtime with a resolved config.
   *
   * Injected so this module stays free of Electron and of the concrete
   * runtime, which is what makes the whole save path testable.
   */
  startRuntime: (config: AgentRuntimeConfig) => void;
};

/**
 * The main-process half of the settings IPC.
 *
 * Every entry point treats its argument as untrusted: shapes are
 * checked at runtime, results are built only from known-safe values,
 * and any message that could conceivably echo a secret is scrubbed
 * against the submitted key before being returned.
 */
export class SettingsController {
  constructor(private readonly deps: SettingsControllerDeps) {}

  /**
   * Non-secret snapshot for `settings:get`.
   *
   * Never touches the stored key's plaintext — `hasStoredApiKey` is a
   * file-existence check — so there is no path by which a read could
   * leak the secret.
   */
  getSnapshot(): SettingsSnapshot {
    const provider = this.readProviderOrNull();

    return {
      provider,
      isConfigured: provider !== null && this.deps.settings.hasStoredApiKey(),
      hasStoredApiKey: this.deps.settings.hasStoredApiKey(),
    };
  }

  /**
   * Validate, persist, regenerate the Pi config, then start the runtime.
   *
   * Ordering matters. Settings are persisted first, so a validation or
   * encryption failure leaves the previous configuration completely
   * untouched. The Pi config is regenerated next — atomically — and the
   * runtime is only stopped and replaced once a usable replacement is
   * fully resolved. A failure at any stage reports an error and leaves
   * whatever was already running alone.
   */
  save(raw: unknown): SettingsSaveResult {
    const parsed = parseSaveSettingsInput(raw);

    if (!parsed.ok) {
      return parsed;
    }

    const { baseUrl, modelId, apiKey } = parsed.input;

    // Scrubbed against whatever the caller submitted, so even an
    // unexpected exception cannot echo the secret back to the renderer.
    const scrub = (message: string) => scrubSecrets(message, [apiKey]);

    try {
      this.deps.settings.saveProviderSettings({ baseUrl, modelId }, apiKey);
    } catch (error) {
      return failure(error, scrub);
    }

    const started = this.generateAndStart(baseUrl, modelId);

    if (!started.ok) {
      /*
       * The failure is a code; the message is the summariser's short,
       * safe rendering of it. No exception text crosses IPC, and the
       * result is still scrubbed against the submitted key as defence
       * in depth.
       */
      return {
        ok: false,
        error: {
          code: started.failure.kind,
          message: scrub(
            summarizeRuntimeError(started.failure, { secrets: [apiKey] })
              .error,
          ),
        },
      };
    }

    return { ok: true, settings: this.getSnapshot() };
  }

  /**
   * Regenerate the Pi config from stored settings and start the runtime.
   *
   * Used at launch and whenever a start has to be retried. Reports a
   * failure code instead of throwing so the caller can summarise it into
   * the existing "error" status.
   */
  startFromStoredSettings(): StartAttempt {
    let provider: ProviderSettings | null;

    try {
      provider = this.deps.settings.readProviderSettings();
    } catch (error) {
      // Distinguishes "unreadable file" from "no file", which the
      // renderer could not tell apart from a null provider alone.
      return { ok: false, failure: settingsReadFailure(error) };
    }

    if (!provider) {
      return { ok: false, failure: { kind: "setup_required" } };
    }

    if (!this.deps.settings.hasStoredApiKey()) {
      return { ok: false, failure: { kind: "api_key_missing" } };
    }

    try {
      validateProviderSettings(provider);
    } catch (error) {
      return { ok: false, failure: invalidSettingsFailure(error) };
    }

    const started = this.generateAndStart(provider.baseUrl, provider.modelId);

    if (!started.ok) {
      return { ok: false, failure: started.failure };
    }

    return { ok: true };
  }

  /**
   * Write the app-owned Pi config and hand the resolved runtime over.
   *
   * Shared by save and launch so both paths behave identically. Nothing
   * here stops the current runtime; that is the injected
   * startRuntime's job, and it only runs once a config has been
   * generated and resolved successfully.
   *
   * The catch clauses deliberately discard the exception: every one of
   * them can quote a filesystem path or a third-party message, and the
   * code alone is enough for the summariser to say something actionable.
   */
  private generateAndStart(
    baseUrl: string,
    modelId: string,
  ): { ok: true } | { ok: false; failure: RuntimeFailure } {
    try {
      writePiConfig(this.deps.piAgentDir, { baseUrl, modelId });
    } catch {
      return { ok: false, failure: { kind: "config_write_failed" } };
    }

    let resolution: ReturnType<typeof resolveRuntimeConfig>;

    try {
      resolution = resolveRuntimeConfig({
        settings: this.deps.settings,
        piAgentDir: this.deps.piAgentDir,
        cwd: this.deps.cwd,
      });
    } catch {
      return { ok: false, failure: { kind: "prepare_failed" } };
    }

    if (!resolution.ok) {
      return { ok: false, failure: resolution.failure };
    }

    try {
      this.deps.startRuntime(resolution.config);
    } catch {
      return { ok: false, failure: { kind: "start_failed" } };
    }

    return { ok: true };
  }

  private readProviderOrNull() {
    try {
      return this.deps.settings.readProviderSettings();
    } catch {
      // An unreadable settings file must not break the settings UI: the
      // user needs it precisely in order to fix the configuration.
      return null;
    }
  }
}

type ParsedInput =
  | { ok: true; input: SaveSettingsInput }
  | { ok: false; error: SettingsError };

/**
 * Runtime validation of a save payload.
 *
 * TypeScript types are not enforcement — anything can arrive over IPC —
 * so every field is checked here. Unknown fields are rejected rather
 * than ignored.
 */
export function parseSaveSettingsInput(raw: unknown): ParsedInput {
  const reject = (
    code: string,
    message: string,
    field?: SettingsField,
  ): ParsedInput => ({ ok: false, error: { code, message, field } });

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return reject("invalid_payload", "Settings payload must be an object.");
  }

  const record = raw as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return reject(
        "unexpected_field",
        "Settings payload contained an unexpected field.",
      );
    }
  }

  if (typeof record.baseUrl !== "string") {
    return reject("invalid_payload", "Base URL is required.", "baseUrl");
  }

  if (typeof record.modelId !== "string") {
    return reject("invalid_payload", "Model ID is required.", "modelId");
  }

  // Omitted, null or blank all mean "keep the stored key".
  if (
    record.apiKey !== undefined &&
    record.apiKey !== null &&
    typeof record.apiKey !== "string"
  ) {
    return reject(
      "invalid_payload",
      "API key must be text.",
      "apiKey",
    );
  }

  return {
    ok: true,
    input: {
      baseUrl: record.baseUrl,
      modelId: record.modelId,
      ...(typeof record.apiKey === "string" ? { apiKey: record.apiKey } : {}),
    },
  };
}

/**
 * Map an exception onto a safe, structured error.
 *
 * SettingsError messages are authored here and known not to contain
 * user input; anything else is wrapped in a fallback and scrubbed as a
 * defence in depth.
 */
function failure(
  error: unknown,
  scrub: (message: string) => string,
  fallback = "Saving settings failed.",
): SettingsSaveResult {
  if (error instanceof SettingsServiceError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: scrub(error.message),
        ...(error.field ? { field: error.field } : {}),
      },
    };
  }

  return {
    ok: false,
    error: { code: "unexpected", message: `${fallback} ${scrub(describe(error))}` },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Remove any literal occurrence of a secret from a message.
 *
 * A last line of defence: the messages above are already built from
 * safe strings, but an exception from a third-party library could in
 * principle quote the value it was handed.
 */
export function scrubSecrets(
  message: string,
  secrets: Array<string | undefined | null>,
): string {
  let out = message;

  for (const secret of secrets) {
    // Very short values are skipped: redacting "a" would mangle text
    // without protecting anything meaningful.
    if (typeof secret === "string" && secret.trim().length >= 4) {
      out = out.split(secret).join("[redacted]");
    }
  }

  return out;
}
