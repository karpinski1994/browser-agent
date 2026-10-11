/*
 * Pure, DOM-free mapping from runtime state to what the status line
 * should say.
 *
 * Split out from renderer.ts so the display rules — including the ones
 * that keep an error readable — are testable without a DOM, and so the
 * renderer cannot quietly reintroduce a bare "Error".
 */
import type { AgentStatus } from "../shared/types";

export type StatusTone = "neutral" | "ready" | "busy" | "error";

export type StatusView = {
  text: string;
  tone: StatusTone;

  /**
   * Tooltip text, or null when there is nothing worth showing.
   *
   * Null clears the attribute, which is what stops a stale reason from
   * lingering over an unrelated state.
   */
  tooltip: string | null;
};

export type StatusViewInput = {
  /** A provider and key are both stored. */
  isConfigured: boolean;

  /**
   * The settings screen is up because nothing is configured yet.
   *
   * Distinct from `!isConfigured` because the renderer always shows the
   * setup screen in that case, and the runtime's own reason — which for
   * first launch duplicates it — is not what the overlay should say.
   */
  showSetupMessage: boolean;

  status: AgentStatus;
  error: string | null;
  detail: string | null;
};

/**
 * Last resort for a corrupted or impossible incoming state.
 *
 * Normal operation never reaches this: the main process guarantees a
 * non-empty `error` on every "error" snapshot. It exists so a malformed
 * payload cannot put the word "Error" alone on screen.
 */
export const FALLBACK_ERROR_TEXT = "Agent encountered an unexpected error";

/**
 * Everything the compact 420px status line can usefully say.
 *
 * The error string is deliberately not truncated here: it arrives from
 * main already bounded to 80 characters, and re-truncating would risk
 * hiding the part that names the problem.
 */
export function statusView(input: StatusViewInput): StatusView {
  if (input.showSetupMessage) {
    /*
     * No tooltip: the setup screen next to it is the instruction, and a
     * runtime reason here would just compete with it.
     */
    return { text: "Setup required", tone: "error", tooltip: null };
  }

  switch (input.status) {
    case "starting":
      return { text: "Starting agent...", tone: "busy", tooltip: null };

    case "opening_browser":
      return { text: "Opening browser...", tone: "busy", tooltip: null };

    case "working":
      return { text: "Agent working...", tone: "busy", tooltip: null };

    case "ready":
      return { text: "Ready", tone: "ready", tooltip: null };

    case "stopped":
      return { text: "Stopped", tone: "neutral", tooltip: null };

    case "error": {
      const text = nonEmpty(input.error) ?? FALLBACK_ERROR_TEXT;

      /*
       * Prefer the longer diagnostic when there is one, but fall back
       * to the summary so a tooltip is never empty — an empty title
       * attribute renders as a permanent blank tooltip box in Chromium.
       */
      const tooltip = nonEmpty(input.detail) ?? text;

      return { text, tone: "error", tooltip };
    }
  }
}

function nonEmpty(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}
