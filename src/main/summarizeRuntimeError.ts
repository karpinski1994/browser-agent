/*
 * Pure, side-effect-free classification of runtime failures into short,
 * safe, user-facing messages.
 *
 * No Electron, no filesystem, no environment, no logging. Deterministic
 * and table-testable in isolation.
 *
 * SECURITY CONTRACT
 * -----------------
 * Two classes of input exist here and they are treated differently:
 *
 *   Structured facts (exit code, signal, spawn errno, our own failure
 *   codes) are values we chose. They can be echoed into a message.
 *
 *   Free text (a Pi RPC `response.error`, a provider HTTP body surfaced
 *   as `message_end.errorMessage`, an exception message) can contain
 *   request bodies, the system prompt, user prompts or credentials.
 *   Verified against the installed Pi 1.1.0: a provider 401 arrives as
 *   `errorMessage` literally containing `401: {"message":"Incorrect API
 *   key provided: <the key>"}`. Scrubbing a known API key out of such
 *   text does NOT make the rest of it safe to display — the remainder
 *   can still be a request body or a prompt. Free text is therefore
 *   used only to *classify* the failure; unless it matches a recognised
 *   pattern, the opaque fallback is returned and the text is discarded.
 *
 * Nothing in this module returns `Error.stack`, a raw exception, a raw
 * provider body or a raw stderr tail. `detail` is assembled only from
 * safe structured facts.
 */

/** Longest user-facing error string, ellipsis included. */
export const MAX_ERROR_LENGTH = 80;

/** Longest detail tooltip string, ellipsis included. */
export const MAX_DETAIL_LENGTH = 200;

/** How many characters of the current child's stderr tail are retained. */
export const MAX_STDERR_TAIL = 4096;

export const FALLBACK_ERROR = "Agent encountered an unexpected error";

export type RuntimeFailure =
  /** Nothing usable to start from; the setup screen is the fix. */
  | { kind: "setup_required" }
  /** Settings exist but no credential is stored. */
  | { kind: "api_key_missing" }
  /** settings.json exists but cannot be parsed. */
  | { kind: "settings_unreadable" }
  /** The stored ciphertext will not decrypt (keychain changed). */
  | { kind: "api_key_unreadable" }
  /**
   * settings.json parsed but the provider section is unusable.
   * `message`, when present, was authored by this app and is safe to
   * summarise; it is never a third-party exception message.
   */
  | { kind: "settings_invalid"; field?: string; message?: string }
  /** The app-owned Pi config could not be written. */
  | { kind: "config_write_failed" }
  /** Config written but the runtime could not be prepared from it. */
  | { kind: "prepare_failed" }
  /** The runtime was resolved but could not be handed to the runtime. */
  | { kind: "start_failed" }
  /** `spawn` threw synchronously. `errno` is the OS error code. */
  | { kind: "spawn"; errno?: string | null }
  /** The child emitted an asynchronous `error` event. */
  | { kind: "child_error"; errno?: string | null }
  /** The current child exited without the app asking it to. */
  | { kind: "exit"; code: number | null; signal: string | null }
  /** Pi rejected a command written to its stdin. */
  | { kind: "rpc_response"; message?: string | null }
  /**
   * The provider failed mid-run. Pi 1.1.0 reports this on the message
   * stream (`message_end` for an assistant message with
   * `stopReason: "error"` and an `errorMessage`), NOT as a `response`
   * and NOT as a process exit — verified by running the installed
   * binary against a loopback endpoint answering 401 and 404.
   */
  | { kind: "provider_error"; message?: string | null }
  /** A write to the child's stdin failed. */
  | { kind: "write_failed" }
  /** stdout stopped being valid JSON-lines. */
  | { kind: "malformed_rpc" }
  /**
   * Anything else. `trusted` marks text authored by this app, which may
   * therefore be summarised; untrusted text is classified or discarded.
   */
  | { kind: "unknown"; message?: string | null; trusted?: boolean };

export type RuntimeFailureContext = {
  /** Configured model id, used for the model-not-found message. */
  modelId?: string;

  /** Known secret values to scrub before any other processing. */
  secrets?: Array<string | undefined | null>;

  /**
   * Retained tail of the current child's stderr. Used ONLY to choose a
   * classification; it is never echoed into `error` or `detail`.
   */
  stderrTail?: string;
};

export type RuntimeErrorSummary = {
  /** Short, user-facing, always non-empty. */
  error: string;

  /** Safe bounded diagnostic for a tooltip, or null. */
  detail: string | null;
};

/*
 * Patterns are matched case-insensitively against free text purely to
 * decide *which* fixed message to return. The matched text itself is
 * never returned.
 *
 * `401` is only recognised when followed by a colon, which is the exact
 * shape Pi's openai-completions transport produces (`"401: {json}"`) or
 * preceded by an auth keyword. A bare `401` anywhere in a string — a
 * port number, a path segment — must not turn an unrelated failure into
 * "API key rejected".
 */
const AUTH_PATTERNS: RegExp[] = [
  /\b401\s*:/i,
  /\b(?:status|code|http)\s*[:=]?\s*401\b/i,
  /\bunauthori[sz]ed\b/i,
  /\binvalid[\s_-]*(api[\s_-]*key|key|credentials?)\b/i,
  /\bincorrect[\s_-]*(api[\s_-]*key|key)\b/i,
  /\b(api[\s_-]*key)\b[^.\n]{0,30}\b(invalid|rejected|revoked|expired|missing|wrong)\b/i,
  /\bauthentication\s+failed\b/i,
  /\bauth(?:orization)?\s+failed\b/i,
  /\binvalid[\s_-]*(bearer[\s_-]*token|token)\b/i,
  /\bbad\s+credentials\b/i,
  /\b(token|credentials?)\s+(is\s+)?(invalid|expired|revoked)\b/i,
  /\bmissing\s+(api[\s_-]*key|authorization)\b/i,
  /\bforbidden\b/i,
];

const MODEL_PATTERNS: RegExp[] = [
  /\bmodel[\s_-]?not[\s_-]?found\b/i,
  /\bmodel\b[^.\n]{0,40}\bnot\s+found\b/i,
  /\b(?:not\s+found|unknown|does\s+not\s+exist|missing)\b[^.\n]{0,40}\bmodel\b/i,
  /\binvalid\s+model\b/i,
  /\bno\s+such\s+model\b/i,
  /\bmodel\b[^.\n]{0,40}\b(does\s+not\s+exist|is\s+not\s+(available|supported))\b/i,
  /\bunsupported\s+model\b/i,
];

/**
 * Recognisable credential shapes. These are redacted from any text that
 * is about to be summarised, so a key can never survive into a message
 * even if the caller failed to pass it in `secrets`.
 */
const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [
    /\b(authorization\s*[:=]\s*)?bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    "$1Bearer [redacted]",
  ],
  [
    // Optional scheme word so `Proxy-Authorization: Basic <token>` is
    // caught too; without it only `Basic` (5 chars) would be matched.
    /\b(authorization|proxy-authorization)\s*[:=]\s*(?:[A-Za-z][A-Za-z-]*\s+)?[^\s,;]{6,}/gi,
    "$1: [redacted]",
  ],
  [
    /\b(api[_-]?key|apikey|secret|token|password|passwd)\b(["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi,
    "$1$2[redacted]",
  ],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]"],
  [
    /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
    "[redacted]",
  ],
];

/**
 * Collapse control characters and newlines so a summarised string is
 * always single-line and cannot smuggle terminal escapes or markup into
 * the status line or its tooltip.
 */
export function normalizeToOneLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bound(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max - 1)}…`;
}

/**
 * Remove known secrets and recognisable credential shapes from text.
 *
 * Runs BEFORE truncation, so a key split across a truncation boundary
 * cannot slip through, and before classification, so a key echoed inside
 * a provider error cannot influence what the user sees.
 */
export function scrubCredentials(
  value: string,
  secrets: Array<string | undefined | null> = [],
): string {
  let out = value;

  for (const secret of secrets) {
    // Very short values are skipped: replacing "a" would mangle text
    // without protecting anything meaningful.
    if (typeof secret === "string" && secret.trim().length >= 4) {
      out = out.split(secret).join("[redacted]");
    }
  }

  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, replacement);
  }

  return out;
}

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function isAuth(text: string): boolean {
  return matchesAny(AUTH_PATTERNS, text);
}

function isModel(text: string): boolean {
  return matchesAny(MODEL_PATTERNS, text);
}

/**
 * Summarise free text whose provenance is unknown.
 *
 * Returns null when the text cannot be classified into a message we are
 * willing to show, which is the common case for provider bodies.
 */
function classifyFreeText(text: string): string | null {
  const probe = normalizeToOneLine(text);

  if (!probe) {
    return null;
  }

  if (isAuth(probe)) {
    return "API key rejected by endpoint";
  }

  if (isModel(probe)) {
    return null; // caller decides, because it needs the configured id
  }

  return null;
}

/** `Model not found: <configured id>`, bounded and single-line. */
function modelNotFound(modelId: string | undefined): string {
  const id = normalizeToOneLine(modelId ?? "");

  if (!id) {
    return "Model not found";
  }

  // Bound the id: it is user-configurable and must not flood the bar.
  return bound(`Model not found: ${bound(id, 40)}`, MAX_ERROR_LENGTH);
}

function describeStderr(context: RuntimeFailureContext): string | null {
  const captured = (context.stderrTail ?? "").length;

  if (captured <= 0) {
    return null;
  }

  return `stderr captured (${captured} chars) but withheld`;
}

const AUTH_DETAIL = "The endpoint rejected the request as unauthorised.";
const MODEL_DETAIL = "The endpoint did not recognise the configured model.";

/**
 * Turn a runtime failure into a short safe message plus an optional
 * tooltip detail.
 *
 * The result is guaranteed to have a non-empty `error`; that invariant
 * is what lets the renderer treat "error status" as "there is something
 * to tell the user".
 */
export function summarizeRuntimeError(
  failure: RuntimeFailure,
  context: RuntimeFailureContext = {},
): RuntimeErrorSummary {
  switch (failure.kind) {
    case "setup_required":
      return {
        error: "Setup required — configure a provider in Settings",
        detail: "No usable base URL, API key and model ID are stored.",
      };

    case "api_key_missing":
      return {
        error: "API key missing — add it in Settings",
        detail: "A provider is configured but no credential is stored.",
      };

    case "api_key_unreadable":
      return {
        error: "Stored API key unreadable — re-enter it",
        detail:
          "The saved credential could not be decrypted. Leaving the key blank in Settings will not help; enter a replacement.",
      };

    case "settings_unreadable":
      return {
        error: "Settings could not be read",
        detail: "settings.json is missing or malformed.",
      };

    case "settings_invalid": {
      // `message` is authored by this app (validateProviderSettings), so
      // a bounded single-line summary of it is safe to show.
      const authored = normalizeToOneLine(failure.message ?? "");

      return {
        error: authored
          ? bound(authored, MAX_ERROR_LENGTH)
          : failure.field
            ? bound(
                `Settings invalid — check the ${normalizeToOneLine(failure.field)}`,
                MAX_ERROR_LENGTH,
              )
            : "Provider settings are invalid",
        detail: "The stored provider configuration failed validation.",
      };
    }

    case "config_write_failed":
      return {
        error: "Could not write agent configuration",
        detail: "The app-owned Pi config directory was not written.",
      };

    case "prepare_failed":
      return {
        error: "Could not prepare the agent runtime",
        detail: "The stored configuration did not resolve to a launch.",
      };

    case "start_failed":
      return {
        error: "Could not start the agent runtime",
        detail: "The resolved configuration could not be launched.",
      };

    case "spawn":
    case "child_error": {
      const errno = typeof failure.errno === "string" ? failure.errno : "";

      if (errno === "ENOENT") {
        return {
          error: "pnpm not found on PATH",
          detail: "The agent is launched with `pnpm exec pi`.",
        };
      }

      if (errno) {
        return {
          error: bound(`Agent could not start (${errno})`, MAX_ERROR_LENGTH),
          detail: "The agent process could not be created.",
        };
      }

      return {
        error: "Agent could not be started",
        detail: "The agent process could not be created.",
      };
    }

    case "exit": {
      /*
       * The tail is inspected only to pick a fixed message. Pi reports
       * startup diagnostics (extension load failures, an unusable
       * model) on stderr before exiting, so a bare "exited (code 1)"
       * would throw away the only explanation the user gets.
       */
      const tail = context.stderrTail ?? "";

      if (tail && isAuth(tail)) {
        return {
          error: "API key rejected by endpoint",
          detail: describeStderr(context) ?? AUTH_DETAIL,
        };
      }

      if (tail && isModel(tail)) {
        return {
          error: modelNotFound(context.modelId),
          detail: describeStderr(context) ?? MODEL_DETAIL,
        };
      }

      const { code, signal } = failure;

      if (typeof code === "number") {
        return {
          error: bound(`Agent exited (code ${code})`, MAX_ERROR_LENGTH),
          detail: describeStderr(context) ?? "The agent process ended unexpectedly.",
        };
      }

      if (typeof signal === "string" && signal) {
        return {
          error: bound(
            `Agent killed (${normalizeToOneLine(signal).slice(0, 24)})`,
            MAX_ERROR_LENGTH,
          ),
          detail:
            describeStderr(context) ??
            "The agent process was terminated by a signal.",
        };
      }

      return {
        error: "Agent process exited unexpectedly",
        detail: describeStderr(context) ?? "No exit code or signal was reported.",
      };
    }

    case "write_failed":
      return {
        error: "Lost connection to the agent",
        detail: "A command could not be delivered to the agent process.",
      };

    case "malformed_rpc":
      return {
        error: "Agent stopped responding",
        detail:
          "The agent process stopped emitting valid messages, so it can no longer be trusted to communicate.",
      };

    case "rpc_response": {
      // Pi's own command-rejection text. Used for classification only.
      const text = normalizeToOneLine(failure.message ?? "");

      if (classifyFreeText(text) === "API key rejected by endpoint") {
        return { error: "API key rejected by endpoint", detail: AUTH_DETAIL };
      }

      if (isModel(text)) {
        return { error: modelNotFound(context.modelId), detail: MODEL_DETAIL };
      }

      return {
        error: "Agent rejected the command",
        detail: "The agent process declined the request.",
      };
    }

    case "provider_error": {
      const text = normalizeToOneLine(failure.message ?? "");

      if (isAuth(text)) {
        return { error: "API key rejected by endpoint", detail: AUTH_DETAIL };
      }

      if (isModel(text)) {
        return { error: modelNotFound(context.modelId), detail: MODEL_DETAIL };
      }

      // Anything else out of a provider body is discarded: it may hold
      // the request payload, the system prompt or the user's prompt.
      return {
        error: FALLBACK_ERROR,
        detail: "The provider returned an error that was not safe to display.",
      };
    }

    case "unknown": {
      const text = normalizeToOneLine(
        scrubCredentials(failure.message ?? "", context.secrets ?? []),
      );

      if (!text) {
        return { error: FALLBACK_ERROR, detail: null };
      }

      // Untrusted text: classify, or discard entirely.
      if (!failure.trusted) {
        if (isAuth(text)) {
          return { error: "API key rejected by endpoint", detail: null };
        }

        if (isModel(text)) {
          return { error: modelNotFound(context.modelId), detail: null };
        }

        return { error: FALLBACK_ERROR, detail: null };
      }

      // Trusted text we authored: a bounded single-line summary is fine.
      return { error: bound(text, MAX_ERROR_LENGTH), detail: null };
    }
  }
}

/**
 * Guarantee a non-empty, bounded message even if a caller constructs a
 * malformed summary by hand. The renderer relies on this invariant: an
 * "error" snapshot always has something to show.
 */
export function ensureSafeErrorMessage(
  summary: RuntimeErrorSummary,
): RuntimeErrorSummary {
  const error = normalizeToOneLine(summary.error);

  return {
    error: error ? bound(error, MAX_ERROR_LENGTH) : FALLBACK_ERROR,
    detail: summary.detail
      ? bound(normalizeToOneLine(summary.detail), MAX_DETAIL_LENGTH)
      : null,
  };
}
