import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderSettings } from "../shared/types";

import { writeFileAtomic } from "./fsAtomic";

/**
 * Bump when the on-disk shape changes so older files can be migrated
 * or rejected rather than misread.
 */
export const SETTINGS_VERSION = 1;

/**
 * Pi provider id the app generates into models.json.
 *
 * Arbitrary by design: nothing about it references a vendor, and Pi
 * accepts any id here (verified against providerIds(), which includes
 * config.getProviderIds(), so a provider defined only in models.json
 * is registered even with no built-in counterpart).
 */
export const PI_PROVIDER_ID = "custom";

/**
 * Pi wire protocol for that provider.
 *
 * "openai-completions" is the generic OpenAI-compatible chat
 * implementation. Verified against Pi's own model catalogs, which use
 * it for non-OpenAI hosts such as ant-ling.
 */
export const PI_API = "openai-completions";

export type SettingsPaths = {
  /** Non-secret settings. Never contains the API key. */
  settingsPath: string;

  /** safeStorage-encrypted API key, kept apart from settings.json. */
  apiKeyPath: string;
};

/** Exact shape of settings.json. */
export type SettingsFile = {
  version: number;
  provider: ProviderSettings;
};

/**
 * Abstraction over at-rest secret protection.
 *
 * Injected rather than imported so this module stays free of Electron
 * and can be exercised directly. Production uses
 * createSafeStorageEncryptor() from secureStorage.ts.
 */
export interface Encryptor {
  /** False when no OS-backed encryption exists. */
  readonly available: boolean;

  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

export type SettingsErrorCode =
  | "invalid_settings"
  | "encryption_unavailable"
  | "unreadable_settings"
  | "unreadable_api_key";

/**
 * Carries a code rather than a message so callers can branch without
 * string matching. Messages never include the API key.
 */
export class SettingsError extends Error {
  readonly code: SettingsErrorCode;

  /** Field the problem applies to, when it maps to one input. */
  readonly field: "baseUrl" | "apiKey" | "modelId" | undefined;

  constructor(
    code: SettingsErrorCode,
    message: string,
    field?: "baseUrl" | "apiKey" | "modelId",
  ) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
    this.field = field;
  }
}

/**
 * Validate a provider settings object.
 *
 * Throws SettingsError with an actionable message. Base URLs are
 * checked for shape only — any HTTP(S) host is allowed, so nothing here
 * locks the app to a particular vendor.
 */
export function validateProviderSettings(
  provider: ProviderSettings,
): void {
  const baseUrl = provider.baseUrl?.trim() ?? "";

  if (!baseUrl) {
    throw new SettingsError(
      "invalid_settings",
      "Base URL is required.",
      "baseUrl",
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new SettingsError(
      "invalid_settings",
      "Base URL must be an absolute URL such as https://api.example.com/v1.",
      "baseUrl",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SettingsError(
      "invalid_settings",
      `Base URL must use http or https (received "${parsed.protocol}").`,
      "baseUrl",
    );
  }

  if (!parsed.host) {
    throw new SettingsError(
      "invalid_settings",
      "Base URL must include a host.",
      "baseUrl",
    );
  }

  const modelId = provider.modelId?.trim() ?? "";

  if (!modelId) {
    throw new SettingsError(
      "invalid_settings",
      "Model ID is required.",
      "modelId",
    );
  }
}

/**
 * Persist and read the app's provider configuration.
 *
 * The API key is encrypted with safeStorage and stored in a separate
 * file, so settings.json can be read — and handed to the renderer —
 * without any path that returns the secret.
 */
export class SettingsService {
  constructor(
    private readonly paths: SettingsPaths,
    private readonly encryptor: Encryptor,
  ) {}

  /** Derive the standard locations from an Electron userData dir. */
  static pathsForUserData(userDataDir: string): SettingsPaths {
    return {
      settingsPath: join(userDataDir, "settings.json"),
      apiKeyPath: join(userDataDir, "secrets", "api-key.enc"),
    };
  }

  /**
   * Whether a complete configuration has been saved.
   *
   * Both files must exist: settings.json alone would mean a provider
   * with no usable credential.
   */
  hasConfiguredProvider(): boolean {
    return (
      this.fileExists(this.paths.settingsPath) &&
      this.fileExists(this.paths.apiKeyPath)
    );
  }

  /**
   * Read the non-secret settings.
   *
   * This is the only settings-read operation intended for renderer
   * use, and its return type has no field capable of carrying the key.
   */
  readProviderSettings(): ProviderSettings | null {
    const file = this.readSettingsFile();

    if (!file) {
      return null;
    }

    return { ...file.provider };
  }

  /**
   * Validate and persist a provider configuration, optionally replacing
   * the stored API key.
   *
   * Passing a blank or omitted key keeps whatever is already stored, so
   * changing Base URL or Model ID does not force the user to retype a
   * secret. In that case the encrypted key file is not rewritten at
   * all — the existing ciphertext is left byte-for-byte intact, which
   * also means a failure part-way cannot corrupt it.
   *
   * If there is no stored key to retain, a blank key is an error rather
   * than a silent no-op that would produce an unusable configuration.
   *
   * A non-blank key is encrypted before anything is written. If
   * OS-backed encryption is unavailable this throws and writes nothing,
   * rather than falling back to plaintext.
   */
  saveProviderSettings(
    provider: ProviderSettings,
    apiKey?: string | null,
  ): void {
    validateProviderSettings(provider);

    const submittedKey = apiKey?.trim() ?? "";
    const hasStoredKey = this.fileExists(this.paths.apiKeyPath);

    if (!submittedKey && !hasStoredKey) {
      throw new SettingsError(
        "invalid_settings",
        "API key is required.",
        "apiKey",
      );
    }

    // Checked before any write so a machine without encryption cannot
    // end up with a settings.json that promises a credential which was
    // never safely stored. Only relevant when a key is being written.
    if (submittedKey && !this.encryptor.available) {
      throw new SettingsError(
        "encryption_unavailable",
        "Secure OS keychain encryption is unavailable, so the API key cannot be stored. " +
          "Refusing to save it in plaintext.",
        "apiKey",
      );
    }

    if (submittedKey) {
      const ciphertext = this.encryptor.encrypt(submittedKey);

      // Key first, settings second. Each write is individually atomic;
      // if the process dies between them the worst case is an orphaned
      // encrypted key with no settings pointing at it — never a settings
      // file referencing a credential that was never protected.
      writeFileAtomic(
        this.paths.apiKeyPath,
        ciphertext.toString("base64"),
        0o600,
      );
    }

    const settingsFile: SettingsFile = {
      version: SETTINGS_VERSION,
      provider: {
        baseUrl: provider.baseUrl.trim(),
        modelId: provider.modelId.trim(),
      },
    };

    writeFileAtomic(
      this.paths.settingsPath,
      `${JSON.stringify(settingsFile, null, 2)}\n`,
    );
  }

  /**
   * Whether an encrypted API key file exists.
   *
   * Cheap existence check — deliberately does not decrypt, so it is
   * safe to call for every settings read.
   */
  hasStoredApiKey(): boolean {
    return this.fileExists(this.paths.apiKeyPath);
  }

  /**
   * Decrypt the stored API key.
   *
   * Main-process only. Never call this on a path that can reach the
   * renderer, and never log the result.
   */
  readApiKey(): string | null {
    if (!this.fileExists(this.paths.apiKeyPath)) {
      return null;
    }

    let encoded: string;

    try {
      encoded = readFileSync(this.paths.apiKeyPath, "utf8");
    } catch (error) {
      throw new SettingsError(
        "unreadable_api_key",
        `Could not read the stored API key: ${describe(error)}`,
      );
    }

    let plaintext: string;

    try {
      plaintext = this.encryptor.decrypt(
        Buffer.from(encoded.trim(), "base64"),
      );
    } catch (error) {
      throw new SettingsError(
        "unreadable_api_key",
        `Could not decrypt the stored API key: ${describe(error)}`,
      );
    }

    return plaintext;
  }

  private readSettingsFile(): SettingsFile | null {
    if (!this.fileExists(this.paths.settingsPath)) {
      return null;
    }

    let raw: string;

    try {
      raw = readFileSync(this.paths.settingsPath, "utf8");
    } catch (error) {
      throw new SettingsError(
        "unreadable_settings",
        `Could not read settings: ${describe(error)}`,
      );
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SettingsError(
        "unreadable_settings",
        "Settings file is not valid JSON.",
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("provider" in parsed)
    ) {
      throw new SettingsError(
        "unreadable_settings",
        "Settings file is missing the provider section.",
      );
    }

    const provider = (parsed as { provider: unknown }).provider;

    if (
      typeof provider !== "object" ||
      provider === null
    ) {
      throw new SettingsError(
        "unreadable_settings",
        "Settings file has a malformed provider section.",
      );
    }

    const { baseUrl, modelId } = provider as Record<string, unknown>;

    return {
      version: SETTINGS_VERSION,
      provider: {
        baseUrl: typeof baseUrl === "string" ? baseUrl : "",
        modelId: typeof modelId === "string" ? modelId : "",
      },
    };
  }

  private fileExists(filePath: string): boolean {
    try {
      readFileSync(filePath);

      return true;
    } catch {
      return false;
    }
  }
}

/** Describe an error without risking secret leakage from its message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
