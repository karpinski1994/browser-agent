/*
 * Contracts shared between the Electron main process, the preload
 * bridge, and the renderer.
 *
 * These live here rather than in a process-specific file because all
 * three layers must agree on them: the main process produces them, the
 * preload forwards them, and the renderer consumes them.
 */

/**
 * Lifecycle state of the agent runtime.
 *
 * Produced exclusively by AgentRuntimeService in the main process.
 */
export type AgentStatus =
  | "starting"
  | "opening_browser"
  | "working"
  | "ready"
  | "stopped"
  | "error";

/**
 * The authoritative, complete view of the runtime at one point in time.
 *
 * The main process owns this value; the renderer only mirrors it. Every
 * field is always present, including the nulls, so a consumer never has
 * to guess whether an omitted property means "unchanged" or "clear it".
 *
 * Invariants maintained by AgentRuntimeService:
 *
 *   - `status === "error"` always has a non-empty `error`.
 *   - any other status has `error === null` and `detail === null`.
 *   - `error` is a short safe summary; `detail` is a longer safe
 *     diagnostic suitable for a tooltip. Neither can contain an API
 *     key, raw stderr, a raw provider body, a prompt or tool output.
 *   - `revision` increases monotonically and only when one of the
 *     observable fields above changes, which lets a late reader discard
 *     a snapshot that is older than an event it already applied.
 */
export type AgentRuntimeSnapshot = {
  status: AgentStatus;
  error: string | null;
  detail: string | null;
  revision: number;
};

/**
 * The only event currently pushed from main to renderer.
 *
 * It carries a full snapshot rather than a bare status plus an optional
 * error: the renderer's startup race means an event can arrive before
 * the renderer has pulled anything, and partial events make "did the
 * error get cleared?" unanswerable.
 */
export type AgentEvent = {
  type: "agent_status";
  snapshot: AgentRuntimeSnapshot;
};

/**
 * Commands written to the Pi RPC process on stdin, one per line.
 *
 * `id` is echoed back on the matching response. Pi supports more
 * command types than these (abort, follow_up, get_state, ...); this
 * union only covers what the app currently sends.
 */
export type PiCommandType = "prompt" | "steer";

export type PiCommand = {
  id: string;
  type: PiCommandType;
  message: string;
};

/**
 * A "response" event read from the Pi RPC process stdout.
 *
 * Pi acknowledges every command with one of these. On failure it sets
 * `success: false` and a human-readable `error`.
 *
 * Note `id` is optional: for malformed input Pi emits a parse failure
 * with no id at all (`id` is `undefined` and is omitted from the JSON
 * entirely rather than sent as null). `command` is optional for the
 * same reason.
 */
export type PiResponseEvent = {
  type: "response";
  id?: string;
  command?: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

/**
 * Non-secret provider configuration.
 *
 * This is the only part of the settings contract that may cross into
 * the renderer. The API key is deliberately absent: it is persisted
 * separately under Electron safeStorage encryption and is never read
 * back through settings-read operations.
 */
export type ProviderSettings = {
  /**
   * Root of an OpenAI-compatible endpoint, e.g.
   * "https://api.openai.com/v1". Any HTTP(S) host is accepted; nothing
   * here is tied to a specific vendor.
   */
  baseUrl: string;

  /** Model identifier exactly as the endpoint expects it. */
  modelId: string;
};

/**
 * Shape of the object the preload exposes as `window.agent`.
 *
 * Declared once here so the preload cannot drift from what the
 * renderer expects.
 */
export type AgentBridge = {
  agent: {
    send(message: string): Promise<void>;
    steer(message: string): Promise<void>;

    /** Legacy scalar status. Kept so existing readers keep working. */
    getStatus(): Promise<AgentStatus>;

    /**
     * Authoritative runtime snapshot, including the reason for a
     * failure. Added alongside getStatus() rather than replacing it, so
     * the older IPC operation keeps its original return type.
     */
    getSnapshot(): Promise<AgentRuntimeSnapshot>;
  };

  settings: {
    get(): Promise<SettingsSnapshot>;
    save(input: SaveSettingsInput): Promise<SettingsSaveResult>;
  };

  events: {
    on(listener: (event: AgentEvent) => void): () => void;
  };
};

/**
 * Field a settings error applies to, for inline display.
 */
export type SettingsField = "baseUrl" | "apiKey" | "modelId";

/**
 * A settings error safe to show in the UI.
 *
 * Built in the main process from known-safe messages. Never carries a
 * submitted value, so an API key cannot be echoed back through it.
 */
export type SettingsError = {
  code: string;
  message: string;
  field?: SettingsField;
};

/**
 * The non-secret view of settings sent to the renderer.
 *
 * There is deliberately no key field of any kind — not even a boolean
 * holding key material. `hasStoredApiKey` exists so the UI can explain
 * the blank-key behaviour without the key ever crossing IPC.
 */
export type SettingsSnapshot = {
  /** Saved provider, or null when nothing has been saved yet. */
  provider: ProviderSettings | null;

  /** True only when a provider AND a usable stored key both exist. */
  isConfigured: boolean;

  /** Whether a stored key would be retained if none is submitted. */
  hasStoredApiKey: boolean;
};

/**
 * Payload for a save request.
 *
 * `apiKey` omitted or blank means "keep the currently stored key".
 * The main process decides whether that is possible; the renderer never
 * learns the stored value.
 */
export type SaveSettingsInput = {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
};

export type SettingsSaveResult =
  | { ok: true; settings: SettingsSnapshot }
  | { ok: false; error: SettingsError };
