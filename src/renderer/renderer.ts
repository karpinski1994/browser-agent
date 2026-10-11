import type {
  AgentBridge,
  AgentEvent,
  SettingsError,
  SettingsField,
  SettingsSnapshot,
} from "../shared/types";

import {
  applyRuntimeSnapshot,
  INITIAL_RUNTIME_VIEW_STATE,
  type RuntimeViewState,
} from "./runtimeViewState";
import { statusView } from "./statusView";

/*
 * The preload exposes `window.agent` via contextBridge. Importing the
 * shared type here keeps the renderer and preload in sync, and typing
 * the event callback lets us narrow on `event.type` below.
 */
declare global {
  interface Window {
    agent: AgentBridge;
  }
}

const textarea = document.getElementById(
  "prompt",
) as HTMLTextAreaElement;

const submit = document.getElementById(
  "submit",
) as HTMLButtonElement;

const steer = document.getElementById(
  "steer",
) as HTMLButtonElement;

const status = document.getElementById(
  "status",
) as HTMLDivElement;

const gear = document.getElementById(
  "gear",
) as HTMLButtonElement;

const backdrop = document.getElementById(
  "backdrop",
) as HTMLDivElement;

const dialogTitle = document.getElementById(
  "dialog-title",
) as HTMLHeadingElement;

const dialogHint = document.getElementById(
  "dialog-hint",
) as HTMLParagraphElement;

const form = document.getElementById(
  "settings-form",
) as HTMLFormElement;

const baseUrlInput = document.getElementById(
  "base-url",
) as HTMLInputElement;

const apiKeyInput = document.getElementById(
  "api-key",
) as HTMLInputElement;

const modelIdInput = document.getElementById(
  "model-id",
) as HTMLInputElement;

const saveButton = document.getElementById(
  "save",
) as HTMLButtonElement;

const cancelButton = document.getElementById(
  "cancel",
) as HTMLButtonElement;

const formError = document.getElementById(
  "form-error",
) as HTMLDivElement;

const fieldErrors: Record<SettingsField, HTMLDivElement> = {
  baseUrl: document.getElementById("base-url-error") as HTMLDivElement,
  apiKey: document.getElementById("api-key-error") as HTMLDivElement,
  modelId: document.getElementById("model-id-error") as HTMLDivElement,
};

const fieldInputs: Record<SettingsField, HTMLInputElement> = {
  baseUrl: baseUrlInput,
  apiKey: apiKeyInput,
  modelId: modelIdInput,
};

/**
 * Mirrors of the main process's authoritative runtime snapshot.
 *
 * Owned by applyRuntimeSnapshot() rather than assigned ad hoc, so the
 * revision check in that helper is the only way these change. Starts at
 * revision -1 so the initial stopped snapshot (revision 0) is accepted.
 */
let runtimeState: RuntimeViewState = INITIAL_RUNTIME_VIEW_STATE;

/**
 * Last settings snapshot read from main. Deliberately kept in a
 * separate variable from `runtimeState`: settings describe what the
 * user has stored, the runtime state describes what the agent process
 * is doing, and conflating them is how a stale setup message ends up
 * over a live error. It contains no key material — only whether one is
 * stored — so it is safe to hold in renderer memory.
 */
let settingsSnapshot: SettingsSnapshot | null = null;

/** null when closed. "setup" is non-dismissible. */
let dialogMode: "setup" | "settings" | null = null;

let saving = false;

/** Element focus returns to when a dismissible dialog closes. */
let focusReturn: HTMLElement | null = null;

function isConfigured(): boolean {
  return settingsSnapshot !== null && settingsSnapshot.isConfigured;
}

function render() {
  renderStatus();
  renderDialog();
}

function renderStatus() {
  /*
   * Actions are gated on what the main process will actually accept.
   * send() and steer() throw outside ready/working, so the buttons are
   * disabled rather than left to produce IPC errors.
   */
  const canSend = isConfigured() && runtimeState.status === "ready";
  const canSteer = isConfigured() && runtimeState.status === "working";

  submit.disabled = !canSend;
  steer.disabled = !canSteer;
  textarea.disabled = !isConfigured();

  /*
   * The status-to-view mapping lives in a pure module so it can be
   * tested without a DOM. It guarantees the visible error is never the
   * bare word "Error" and that the tooltip is cleared whenever there is
   * no reason worth showing.
   */
  const view = statusView({
    isConfigured: settingsSnapshot !== null && settingsSnapshot.isConfigured,
    showSetupMessage: settingsSnapshot !== null && !settingsSnapshot.isConfigured,
    status: runtimeState.status,
    error: runtimeState.error,
    detail: runtimeState.detail,
  });

  status.textContent = view.text;

  if (view.tone === "neutral") {
    status.removeAttribute("data-tone");
  } else {
    status.setAttribute("data-tone", view.tone);
  }

  // Only ever text we produced in main; never markup, never a raw
  // payload. setAttribute/removeAttribute rather than innerHTML.
  if (view.tooltip === null) {
    status.removeAttribute("title");
  } else {
    status.setAttribute("title", view.tooltip);
  }
}

function renderDialog() {
  const open = dialogMode !== null;

  backdrop.hidden = !open;

  if (!open) {
    return;
  }

  const isSetup = dialogMode === "setup";

  dialogTitle.textContent = isSetup
    ? "Connect a provider"
    : "Settings";

  cancelButton.hidden = isSetup;

  /*
   * The saved key is never sent over IPC, so the password field is
   * always blank on open. The hint tells the user what a blank field
   * will do in this mode — it either keeps the stored key or, on
   * first launch, has to be provided.
   *
   * While the runtime is reporting a failure, "leave it blank" is
   * actively misleading for the two failures a blank field cannot fix:
   * a key that will no longer decrypt, and one the endpoint rejected.
   * Rather than string-matching the message, the advice widens to
   * cover both.
   */
  dialogHint.textContent = isSetup
    ? "Any OpenAI-compatible endpoint works. The key is stored in your system keychain."
    : settingsSnapshot?.hasStoredApiKey
      ? runtimeState.error !== null
        ? "Leave the API key blank to keep the one already stored. If the agent reports an unreadable or rejected key, enter a replacement."
        : "Leave the API key blank to keep the one already stored."
      : "No API key is stored yet — enter one to save.";
}

function openDialog(mode: "setup" | "settings") {
  dialogMode = mode;
  focusReturn = document.activeElement as HTMLElement | null;

  clearErrors();
  prefill();

  render();

  // Focus the first field so the dialog is immediately usable by
  // keyboard without a click.
  baseUrlInput.focus();
}

function closeDialog() {
  if (dialogMode !== "settings") {
    // The setup screen cannot be dismissed: there is nothing usable
    // behind it until a provider is configured.
    return;
  }

  dialogMode = null;
  apiKeyInput.value = "";
  render();

  focusReturn?.focus();
}

function prefill() {
  /*
   * Base URL and Model ID are non-secret and come back from main. The
   * API key never does — apiKeyInput is deliberately left untouched by
   * this function and cleared explicitly on close/save.
   */
  if (settingsSnapshot?.provider) {
    baseUrlInput.value = settingsSnapshot.provider.baseUrl;
    modelIdInput.value = settingsSnapshot.provider.modelId;
  } else {
    baseUrlInput.value = "";
    modelIdInput.value = "";
  }

  apiKeyInput.value = "";
}

function clearErrors() {
  formError.textContent = "";

  for (const field of Object.keys(fieldErrors) as SettingsField[]) {
    fieldErrors[field].textContent = "";
    fieldInputs[field].removeAttribute("aria-invalid");
  }
}

function showError(error: SettingsError) {
  clearErrors();

  const target = error.field ? fieldErrors[error.field] : null;

  if (target) {
    target.textContent = error.message;
    fieldInputs[error.field as SettingsField].setAttribute(
      "aria-invalid",
      "true",
    );
    fieldInputs[error.field as SettingsField].focus();
  } else {
    formError.textContent = error.message;
  }
}

async function handleSave(event: Event) {
  event.preventDefault();

  if (saving) {
    return;
  }

  clearErrors();
  saving = true;
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";

  try {
    const result = await window.agent.settings.save({
      baseUrl: baseUrlInput.value,
      modelId: modelIdInput.value,
      // Blank means "keep the stored key"; main decides whether that
      // is possible. The stored value is never sent to this process.
      apiKey: apiKeyInput.value,
    });

    if (!result.ok) {
      showError(result.error);
      return;
    }

    settingsSnapshot = result.settings;

    /*
     * Never keep a submitted secret in the DOM once it has been
     * persisted, and never claim a connection from this alone — the
     * runtime emits its own status events while it starts up.
     */
    apiKeyInput.value = "";

    if (dialogMode === "setup") {
      dialogMode = null;

      // Move focus off the hidden password field, which would otherwise
      // keep swallowing keystrokes.
      if (isConfigured()) {
        textarea.focus();
      }
    }

    render();
  } catch {
    // A rejection here carries no useful detail for the user and might
    // echo a payload, so a fixed message is shown instead.
    showError({
      code: "ipc_failed",
      message: "Could not save settings. Please try again.",
    });
  } finally {
    saving = false;
    saveButton.disabled = false;
    saveButton.textContent = "Save";
  }
}

function focusableInDialog(): HTMLElement[] {
  return Array.from(
    backdrop.querySelectorAll<HTMLElement>(
      'button:not([hidden]):not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.offsetParent !== null);
}

function trapTab(event: KeyboardEvent) {
  if (event.key !== "Tab" || dialogMode === null) {
    return;
  }

  const focusable = focusableInDialog();

  if (focusable.length === 0) {
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

async function init() {
  /*
   * Subscribe FIRST — the main process owns the state, and it emits
   * transitions immediately, including before this renderer finished
   * loading. Subscribing before pulling is what makes the race
   * deterministic: every snapshot, pushed or pulled, now flows through
   * applyRuntimeSnapshot(), which discards anything older than what has
   * already been applied.
   */
  window.agent.events.on((event: AgentEvent) => {
    if (event.type !== "agent_status") {
      return;
    }

    runtimeState = applyRuntimeSnapshot(runtimeState, event.snapshot);

    render();
  });

  try {
    /*
     * The pull carries the failure reason as well as the status, which
     * is the whole point: a startup failure that happened before this
     * renderer existed is now recoverable instead of showing a bare
     * "Error" — or nothing at all.
     */
    const current = await window.agent.agent.getSnapshot();

    runtimeState = applyRuntimeSnapshot(runtimeState, current);
  } catch {
    // Leave the default; the event stream will correct it.
  }

  try {
    settingsSnapshot = await window.agent.settings.get();
  } catch {
    settingsSnapshot = null;
  }

  render();

  // No usable configuration: show setup instead of a dead overlay.
  if (!isConfigured()) {
    openDialog("setup");
  }
}

form.addEventListener("submit", handleSave);

cancelButton.addEventListener("click", closeDialog);

gear.addEventListener("click", () => {
  openDialog("settings");
});

// Attached to the document so Escape works wherever focus happens to
// be while the dialog is open.
document.addEventListener("keydown", (event) => {
  if (dialogMode === null) {
    return;
  }

  if (event.key === "Escape") {
    closeDialog();

    return;
  }

  trapTab(event);
});

// Clicking the dimmed area closes settings but never setup.
backdrop.addEventListener("mousedown", (event) => {
  if (event.target === backdrop) {
    closeDialog();
  }
});

submit.addEventListener("click", async () => {
  const message = textarea.value.trim();

  // Mirrors what the main process will accept, so a disabled button —
  // not an IPC rejection — is what the user meets in other states.
  if (!message || runtimeState.status !== "ready") {
    return;
  }

  try {
    await window.agent.agent.send(message);

    textarea.value = "";
  } catch {
    // The status line already reflects the runtime state; writing a
    // message into it would be overwritten by the next render anyway.
  }
});

steer.addEventListener("click", async () => {
  const message = textarea.value.trim();

  if (!message || runtimeState.status !== "working") {
    return;
  }

  try {
    await window.agent.agent.steer(message);

    textarea.value = "";
  } catch {
    // As above.
  }
});

init();
