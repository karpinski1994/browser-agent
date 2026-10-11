import { spawn as nodeSpawn } from "node:child_process";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from "node:child_process";
import { EventEmitter } from "node:events";

import type {
  AgentEvent,
  AgentRuntimeSnapshot,
  AgentStatus,
  PiCommand,
  PiResponseEvent,
} from "../shared/types";

import {
  buildSpawnArgs,
  buildSpawnEnv,
  redactSpawnArgs,
  type AgentRuntimeConfig,
} from "./runtimeConfig";
import {
  ensureSafeErrorMessage,
  MAX_STDERR_TAIL,
  summarizeRuntimeError,
  type RuntimeFailure,
  type RuntimeFailureContext,
} from "./summarizeRuntimeError";

/**
 * Seam for constructing the Pi process.
 *
 * Verification scripts substitute a short-lived stand-in so process
 * lifecycle can be exercised without launching a real agent.
 */
export type SpawnPi = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

const defaultSpawnPi: SpawnPi = (command, args, options) =>
  nodeSpawn(
    command,
    args,
    options as Parameters<typeof nodeSpawn>[2],
  ) as ChildProcessWithoutNullStreams;

const STARTUP_PROMPT =
  "Open https://www.google.com in the existing browser. " +
  "This is application startup initialization. " +
  "Do not perform any other task.";

const STARTUP_DELAY_MS = 3000;

/**
 * Statuses in which the application is relying on the child process to
 * keep running. An exit from one of these without a stop request is a
 * failure, not a stop — including an exit with code 0.
 */
const ACTIVE_STATUSES: ReadonlySet<AgentStatus> = new Set([
  "starting",
  "opening_browser",
  "working",
  "ready",
]);

/**
 * A Pi RPC event type worth a one-word lifecycle log line.
 *
 * Only the *type* is logged, never the payload: `message_start`,
 * `message_end`, `agent_end` and `turn_end` all carry the full system
 * prompt and the whole conversation (verified against Pi 1.1.0, where a
 * single `message_start` is ~48 kB including the system prompt).
 */
const LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent_start",
  "agent_settled",
]);

/**
 * How many non-JSON stdout lines are tolerated before the stream is
 * declared unusable.
 *
 * Pi's RPC mode takes over stdout (`takeOverStdout()` in main(), before
 * runRpcMode) and writes every record through
 * `serializeJsonLine`, so in normal operation stdout is strictly
 * JSON-lines and this never trips. It exists because anything printed
 * before the takeover — CLI bootstrap output, a dependency's import
 * side effect, pnpm itself — would land on the same fd as raw text. A
 * couple of such lines are survivable; a stream that has stopped being
 * JSON is not, because the runtime can no longer be trusted to
 * communicate. The lines themselves are never logged: they can carry
 * anything.
 */
const MAX_MALFORMED_LINES = 8;

export class AgentRuntimeService {
  private pi: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private stderrTail = "";
  private malformedLines = 0;

  private status: AgentStatus = "stopped";
  private error: string | null = null;
  private detail: string | null = null;
  private revision = 0;

  /**
   * True while a failure has been reported for the turn currently in
   * flight and has not yet been answered by a healthy turn. Used so a
   * later `agent_settled` cannot quietly turn "API key rejected" back
   * into "Ready".
   */
  private failurePending = false;

  /** Model id of the current/last launch. Safe to name; not a secret. */
  private modelId: string | null = null;

  /** Decrypted key of the current/last launch. Secret; main process only. */
  private secrets: string[] = [];

  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly events = new EventEmitter();

  constructor(
    private readonly spawnPi: SpawnPi = defaultSpawnPi,
    private readonly startupDelayMs: number = STARTUP_DELAY_MS,
  ) {}

  /**
   * Launch Pi with a resolved, configured runtime.
   *
   * There is no built-in provider to fall back to: an unconfigured app
   * should call failStartup() instead, so the absence of settings is
   * reported rather than silently routed to some other vendor.
   */
  start(config: AgentRuntimeConfig) {
    if (this.pi) {
      console.log("[AGENT] Already running, ignoring start()");

      return;
    }

    this.modelId = config.modelId;
    this.secrets = config.apiKey ? [config.apiKey] : [];

    // A new run clears whatever the previous one left behind, so an
    // error from a dead configuration cannot outlive its cause.
    this.clearChildBuffers();
    this.failurePending = false;

    this.setStatus("starting");

    const args = buildSpawnArgs(config);
    const env = buildSpawnEnv(config);

    // The argument list contains the API key, so only the redacted copy
    // may be logged, and only the argument names at that.
    console.log(
      "[AGENT] Starting Pi",
      redactSpawnArgs(args).map((a) => (a === "***" ? "***" : a)),
    );

    let child: ChildProcessWithoutNullStreams;

    try {
      child = this.spawnPi("pnpm", args, {
        cwd: config.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      // Only the OS error code is carried over. The exception's message
      // can quote the command line, which contains the API key.
      this.reportError({
        kind: "spawn",
        errno: errnoOf(error),
      });

      return;
    }

    this.pi = child;

    /*
     * Every handler below is guarded by `this.pi !== child`.
     *
     * Without that, stop() followed by a quick start() would let the
     * *old* process's handlers fire afterwards and clear the new
     * process's reference and status — a stale listener silently
     * resetting a healthy runtime. The guard is also what stops a
     * superseded child from appending to the new child's stderr tail or
     * half-read stdout buffer.
     */
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (data: string) => {
      if (this.pi !== child) {
        return;
      }

      this.handleStdout(data);
    });

    child.stderr.on("data", (data: string) => {
      if (this.pi !== child) {
        return;
      }

      this.appendStderr(data);
    });

    child.stdin.on("error", () => {
      if (this.pi !== child) {
        return;
      }

      // EPIPE and friends. Reported rather than swallowed so the UI
      // cannot sit at "Ready" while nothing is listening on stdin.
      this.reportError({ kind: "write_failed" });
    });

    child.on("error", (error) => {
      if (this.pi !== child) {
        return;
      }

      /*
       * Asynchronous spawn failure (ENOENT, EACCES, ...). Node emits
       * `exit` and/or `close` afterwards — sometimes not at all — so
       * the child is detached here. That both keeps the app from
       * sitting in "starting" forever and makes the later `exit`
       * harmless, which is what prevents double-reporting the same
       * failed launch. Only the errno code is used; the raw exception
       * is never logged because its message can quote the command line.
       */
      this.detachChild(child);

      this.reportError({ kind: "child_error", errno: errnoOf(error) });
    });

    const onChildEnded = (code: number | null, signal: string | null) => {
      if (this.pi !== child) {
        // An older process finally ending. It must not disturb the
        // state of whatever is running now.
        console.log("[PI EXIT] (superseded)");

        return;
      }

      /*
       * Captured before detachChild(): classification needs the tail
       * that just ended, while the runtime must not keep it once the
       * child is gone. Both requirements are satisfied by copying it
       * first rather than by ordering the calls the other way round.
       */
      const stderrTail = this.stderrTail;

      this.detachChild(child);

      if (this.status === "error") {
        /*
         * A specific cause was already reported — a rejected response,
         * a failed write. A bare exit adds nothing the user can act on,
         * so the primary cause is preserved rather than replaced.
         */
        console.log("[PI EXIT] after reported error", { code, signal });

        return;
      }

      if (!ACTIVE_STATUSES.has(this.status)) {
        // Nothing was relying on this process; nothing to report.
        this.setStatus("stopped");

        return;
      }

      console.log("[PI EXIT] unexpectedly", { code, signal });

      this.reportError({ kind: "exit", code, signal }, { stderrTail });
    };

    child.on("exit", onChildEnded);

    // Safety net: an ENOENT'd child can emit `close` without a usable
    // `exit`, and a close before exit must not leave the runtime stuck.
    child.on("close", onChildEnded);

    this.clearStartupTimer();

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;

      // The process may have been stopped or replaced while the timer
      // was pending.
      if (this.pi !== child) {
        return;
      }

      this.openBrowser();
    }, this.startupDelayMs);
  }

  /**
   * Report that the runtime could not start, without spawning anything.
   *
   * Used when settings are missing, unreadable, or the stored key will
   * not decrypt. The summarised message becomes the existing "error"
   * status event, so no new event or status type is needed.
   */
  failStartup(failure: RuntimeFailure) {
    const summary = summarizeRuntimeError(failure, this.failureContext());

    // Only the safe summary is logged; the underlying exception, if
    // there was one, never reaches a log line or a status event.
    console.error("[AGENT] Cannot start:", summary.error);

    this.reportError(failure);
  }

  private clearStartupTimer() {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  /**
   * Drop the current child and reset everything scoped to it.
   *
   * Called before a kill (so the dying process's handlers become
   * "superseded") and on spawn failure (so a child that never really
   * started cannot keep the runtime attached to it).
   */
  private detachChild(child: ChildProcessWithoutNullStreams) {
    if (this.pi === child) {
      this.pi = null;
    }

    this.clearStartupTimer();
    this.clearChildBuffers();
  }

  private clearChildBuffers() {
    this.buffer = "";
    this.stderrTail = "";
    this.malformedLines = 0;
  }

  private openBrowser() {
    console.log("[AGENT] Opening browser...");

    this.setStatus("opening_browser");

    const command: PiCommand = {
      id: `startup-${Date.now()}`,
      type: "prompt",
      message: STARTUP_PROMPT,
    };

    try {
      this.writeCommand(command);
    } catch {
      // writeCommand already reported a safe error and left the UI in
      // the error state; rethrowing here would only surface an
      // unhandled rejection in a timer callback.
    }
  }

  private appendStderr(chunk: string) {
    // Retain a bounded tail only. The full stream is never stored or
    // logged: it can contain anything the child printed, including
    // paths and provider responses.
    this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_TAIL);
  }

  private handleStdout(data: string) {
    this.buffer += data;

    while (true) {
      const newline = this.buffer.indexOf("\n");

      if (newline === -1) {
        break;
      }

      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);

      if (!line.trim()) {
        continue;
      }

      let event: any;

      try {
        event = JSON.parse(line);
      } catch {
        this.noteMalformedLine();

        continue;
      }

      if (event && typeof event === "object" && typeof event.type === "string") {
        if (LIFECYCLE_EVENT_TYPES.has(event.type)) {
          console.log("[PI EVENT]", event.type);
        }
      }

      this.handlePiEvent(event);
    }
  }

  /**
   * Record a stdout line that was not valid JSON.
   *
   * The line is deliberately not logged: malformed output may be raw
   * provider text, a prompt, or a credential. Only the count is kept,
   * and crossing the tolerance turns into a safe "stopped responding"
   * error.
   */
  private noteMalformedLine() {
    this.malformedLines += 1;

    if (this.malformedLines === MAX_MALFORMED_LINES) {
      this.reportError({ kind: "malformed_rpc" });
    }
  }

  private handlePiEvent(event: any) {
    if (!event || typeof event !== "object") {
      return;
    }

    switch (event.type) {
      case "response":
        this.handlePiResponse(event as PiResponseEvent);
        break;

      case "agent_start":
        if (this.status === "opening_browser") {
          console.log("[AGENT] Browser opening...");
        } else if (this.status !== "error" && this.status !== "working") {
          this.setStatus("working");
        }

        break;

      /*
       * The authoritative record of one assistant turn.
       *
       * In Pi 1.1.0 a provider failure never reaches the `response`
       * channel and never kills the process: the prompt is accepted
       * (`success: true`), the HTTP call fails, and the turn is closed
       * with `stopReason: "error"` plus an `errorMessage` holding the
       * status line and the response body. Without this branch a bad
       * API key leaves the app looking healthy.
       *
       * Tool failures are deliberately NOT handled here. They arrive as
       * `tool_execution_end` with `isError: true` while the agent stays
       * healthy and can recover, so they must not become a persistent
       * runtime error.
       */
      case "message_end": {
        const message = event.message;

        if (!message || message.role !== "assistant") {
          break;
        }

        if (message.stopReason === "error") {
          this.failurePending = true;

          this.reportError({
            kind: "provider_error",
            message:
              typeof message.errorMessage === "string"
                ? message.errorMessage
                : null,
          });

          break;
        }

        if (message.stopReason !== "aborted") {
          // A healthy turn supersedes an earlier failure, so a transient
          // outage that recovers on Pi's own retry does not strand the
          // UI in the error state.
          this.failurePending = false;
        }

        break;
      }

      case "agent_settled":
        if (this.failurePending) {
          /*
           * The run "finished" but the turn that just ended failed.
           * Reporting Ready here would erase a still-relevant reason.
           */
          console.log("[AGENT] Turn settled after a reported failure");

          break;
        }

        if (this.status === "opening_browser") {
          console.log("[AGENT] Browser initialization complete");
        }

        this.setStatus("ready");
        break;

      case "agent_end":
        break;

      default:
        break;
    }
  }

  /*
   * Pi replies to every command with a "response" event.
   *
   * A failed response means the command was rejected before the agent
   * run started. Nothing else in the lifecycle reports this, so without
   * handling it here the service stays in "working" forever.
   *
   * Success is deliberately ignored: agent_start/agent_settled remain
   * the only source of the working/ready lifecycle.
   */
  private handlePiResponse(event: PiResponseEvent) {
    if (event.success) {
      console.log("[AGENT] Pi acknowledged a command");

      return;
    }

    this.failurePending = true;

    // The error text is used for classification only and is never
    // logged, echoed or placed in a status event.
    this.reportError({
      kind: "rpc_response",
      message:
        typeof event.error === "string" && event.error.trim()
          ? event.error
          : null,
    });
  }

  send(message: string) {
    if (this.status !== "ready") {
      throw new Error(
        `Agent is not ready. Current state: ${this.status}`,
      );
    }

    const command: PiCommand = {
      id: `prompt-${Date.now()}`,
      type: "prompt",
      message,
    };

    this.writeCommand(command);
    this.setStatus("working");
  }

  steer(message: string) {
    if (this.status !== "working") {
      throw new Error(
        `Agent is not working. Current state: ${this.status}`,
      );
    }

    const command: PiCommand = {
      id: `steer-${Date.now()}`,
      type: "steer",
      message,
    };

    this.writeCommand(command);
  }

  /** Kept for compatibility. Returns the status only, never the reason. */
  getStatus(): AgentStatus {
    return this.status;
  }

  /**
   * A fresh value each call, so a caller cannot mutate the service's
   * state through the returned object.
   */
  getSnapshot(): AgentRuntimeSnapshot {
    return {
      status: this.status,
      error: this.error,
      detail: this.detail,
      revision: this.revision,
    };
  }

  /**
   * Buffer sizes for the current child, in characters.
   *
   * Lengths only — never content — so this is safe to expose to
   * verification scripts without creating a channel for stderr.
   */
  getDiagnostics(): {
    stderrTailChars: number;
    pendingStdoutChars: number;
    malformedLines: number;
  } {
    return {
      stderrTailChars: this.stderrTail.length,
      pendingStdoutChars: this.buffer.length,
      malformedLines: this.malformedLines,
    };
  }

  subscribe(listener: (event: AgentEvent) => void) {
    this.events.on("event", listener);

    return () => {
      this.events.off("event", listener);
    };
  }

  /**
   * Replace the running process with one using a new configuration.
   *
   * Callers are responsible for having already prepared and persisted
   * the replacement — this only handles the swap. stop() detaches the
   * current child before signalling it, so its delayed exit event takes
   * the "superseded" path and cannot disturb the process started here.
   */
  restart(config: AgentRuntimeConfig) {
    this.stop();
    this.start(config);
  }

  stop() {
    this.clearStartupTimer();

    const child = this.pi;

    if (!child) {
      // An intentional stop is a stop whether or not a child was ever
      // attached: the caller asked for "not running", and any previous
      // error belonged to a runtime that no longer exists.
      this.failurePending = false;
      this.clearChildBuffers();
      this.setStatus("stopped");

      return;
    }

    console.log("[AGENT] Stopping Pi...");

    // Detach first: this process is no longer current, so its delayed
    // exit/error/stdout handlers take the "superseded" path rather than
    // mutating whatever is started next. It cannot emit a second error
    // just for being the thing we chose to kill.
    this.pi = null;
    this.clearChildBuffers();
    this.failurePending = false;

    try {
      child.stdin.end();
    } catch {
      // stdin may already be closed by the peer.
    }

    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }

    this.setStatus("stopped");
  }

  private failureContext(): RuntimeFailureContext {
    return {
      modelId: this.modelId ?? undefined,
      secrets: this.secrets,
      stderrTail: this.stderrTail || undefined,
    };
  }

  /**
   * Enter the error state with a safe, bounded summary.
   *
   * Every path into the error state goes through here, which is what
   * makes "error implies a non-empty message" an invariant rather than
   * a convention.
   *
   * `contextOverride` supplies facts that are no longer reachable from
   * the live state — notably the stderr tail of a child that has just
   * been detached and whose buffers were deliberately reset.
   */
  private reportError(
    failure: RuntimeFailure,
    contextOverride: RuntimeFailureContext = {},
  ) {
    const summary = ensureSafeErrorMessage(
      summarizeRuntimeError(failure, {
        ...this.failureContext(),
        ...contextOverride,
      }),
    );

    this.apply({ status: "error", error: summary.error, detail: summary.detail });
  }

  private setStatus(status: AgentStatus) {
    this.apply({ status, error: null, detail: null });
  }

  /**
   * Apply a snapshot transition, bumping the revision only when
   * something observable actually changed.
   */
  private apply(next: {
    status: AgentStatus;
    error: string | null;
    detail: string | null;
  }) {
    // Non-error states never carry a reason, whatever the caller passed.
    const error = next.status === "error" ? next.error : null;
    const detail = next.status === "error" ? next.detail : null;

    if (
      next.status === this.status &&
      error === this.error &&
      detail === this.detail
    ) {
      return;
    }

    this.status = next.status;
    this.error = error;
    this.detail = detail;
    this.revision += 1;

    const snapshot = this.getSnapshot();

    console.log(
      "[AGENT STATUS]",
      snapshot.status,
      snapshot.revision,
      snapshot.error ?? "",
    );

    this.events.emit("event", {
      type: "agent_status",
      snapshot,
    } satisfies AgentEvent);
  }

  /**
   * Write one JSON command to the child's stdin.
   *
   * A failed write transitions the runtime to the error state *before*
   * rejecting, so the caller's IPC promise cannot settle while the UI
   * still claims "Ready" or "Working". The command itself — which
   * carries the user's message — is never logged and never appears in
   * the thrown error.
   */
  private writeCommand(command: PiCommand) {
    const child = this.pi;

    if (!this.isWritable(child)) {
      this.reportError({ kind: "write_failed" });

      throw new Error("Could not deliver the command to the agent.");
    }

    const line = JSON.stringify(command) + "\n";

    try {
      child!.stdin.write(line, (error) => {
        if (error && this.pi === child) {
          this.reportError({ kind: "write_failed" });
        }
      });
    } catch {
      this.reportError({ kind: "write_failed" });

      throw new Error("Could not deliver the command to the agent.");
    }
  }

  private isWritable(
    child: ChildProcessWithoutNullStreams | null,
  ): child is ChildProcessWithoutNullStreams {
    if (!child) {
      return false;
    }

    if (child.killed) {
      return false;
    }

    if (child.stdin.destroyed) {
      return false;
    }

    return child.stdin.writable;
  }
}

/**
 * OS error code of a spawn failure, or null.
 *
 * Only the code is taken: `error.message` for a spawn failure quotes
 * the command line, and ours contains the API key.
 */
function errnoOf(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const code = (error as { code?: unknown }).code;

  return typeof code === "string" && code ? code : null;
}
