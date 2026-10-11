/*
 * Verification for runtime error handling, the snapshot contract,
 * process lifecycle and logging hygiene.
 *
 * Run with: pnpm verify:errors
 *
 * Dependency-free and fully deterministic. Nothing here reads .env,
 * a real API key, the user's settings, a real keychain entry or the
 * real Chromium profile: the provider is never contacted, the Pi
 * process is replaced by an in-memory fake child, and every credential
 * or prompt is a clearly fake sentinel.
 */

import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";

import { AgentRuntimeService, type SpawnPi } from "../src/main/agentRuntimeService";
import { piConfigDirForUserData } from "../src/main/configGenerator";
import type { AgentRuntimeConfig } from "../src/main/runtimeConfig";
import {
  ensureSafeErrorMessage,
  FALLBACK_ERROR,
  MAX_DETAIL_LENGTH,
  MAX_ERROR_LENGTH,
  MAX_STDERR_TAIL,
  normalizeToOneLine,
  scrubCredentials,
  summarizeRuntimeError,
  type RuntimeFailure,
  type RuntimeFailureContext,
} from "../src/main/summarizeRuntimeError";
import type { AgentRuntimeSnapshot } from "../src/shared/types";
import {
  applyRuntimeSnapshot,
  INITIAL_RUNTIME_VIEW_STATE,
} from "../src/renderer/runtimeViewState";
import { statusView } from "../src/renderer/statusView";

/* ------------------------------------------------------------------------- *
 * Sentinels. Every one of these must be absent from anything that can
 * reach a snapshot, a log line or the DOM.
 * ------------------------------------------------------------------------- */

const FAKE_API_KEY = "sk-test-placeholder-not-a-real-key";
const PROMPT_SENTINEL = "USER_PROMPT_SENTINEL_9f3a never leak me";
const SYSTEM_SENTINEL = "SYSTEM_PROMPT_SENTINEL_77bd never leak me";
const TOOL_RESULT_SENTINEL = "TOOL_RESULT_SENTINEL_c41e never leak me";

const ALL_SENTINELS = [
  FAKE_API_KEY,
  PROMPT_SENTINEL,
  SYSTEM_SENTINEL,
  TOOL_RESULT_SENTINEL,
];

/* ------------------------------------------------------------------------- *
 * Log capture, serialised deeply enough that a nested object holding a
 * sentinel would be detected. `[object Object]` would hide it.
 * ------------------------------------------------------------------------- */

function serializeArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }

  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`;
  }

  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

const captured: string[] = [];
const realLog = console.log;
const realError = console.error;

console.log = (...args: unknown[]) => {
  captured.push(args.map(serializeArg).join(" "));
};

console.error = (...args: unknown[]) => {
  captured.push(args.map(serializeArg).join(" "));
};

let passed = 0;

async function check(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
    passed += 1;
    realLog(`  ok   ${name}`);
  } catch (error) {
    realError(`  FAIL ${name}`);
    realError(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------------- *
 * A deterministic in-memory stand-in for the Pi child process.
 *
 * Real child processes cannot be made to emit an arbitrary exit signal,
 * an async ENOENT and a stderr tail on demand, and a multi-second
 * timeout per case would make this suite unusable. Streams are plain
 * EventEmitters so write/emit are synchronous and no assertion depends
 * on libuv scheduling.
 * ------------------------------------------------------------------------- */

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }

  emitText(text: string) {
    this.emit("data", text);
  }
}

class FakeStdin extends EventEmitter {
  destroyed = false;
  writable = true;
  ended = false;

  readonly written: string[] = [];

  /** Make write() throw, as a broken pipe does. */
  throwOnWrite = false;

  /** Invoke the write callback with an error, as an async EPIPE does. */
  callbackError: Error | null = null;

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    if (this.throwOnWrite) {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    }

    this.written.push(chunk);

    if (this.callbackError && callback) {
      callback(this.callbackError);
    } else {
      callback?.(null);
    }

    return true;
  }

  end() {
    this.ended = true;
    this.writable = false;
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly stdin = new FakeStdin();

  killed = false;

  kill(): this {
    this.killed = true;

    return this;
  }

  emitStdout(text: string) {
    this.stdout.emitText(text);
  }

  emitStderr(text: string) {
    this.stderr.emitText(text);
  }

  emitSpawnError(code: string | null) {
    this.emit(
      "error",
      Object.assign(new Error(`spawn failed with ${code ?? "unknown"}`), {
        code,
      }),
    );
  }

  emitExit(code: number | null, signal: string | null = null) {
    this.emit("exit", code, signal);
  }

  emitClose(code: number | null, signal: string | null = null) {
    this.emit("close", code, signal);
  }
}

type Recorder = {
  children: FakeChild[];
  spawnPi: SpawnPi;
};

function makeRecorder(): Recorder {
  const children: FakeChild[] = [];

  const spawnPi: SpawnPi = () => {
    const child = new FakeChild();

    children.push(child);

    return child as never;
  };

  return { children, spawnPi };
}

const CONFIG: AgentRuntimeConfig = {
  piAgentDir: piConfigDirForUserData("/tmp/agent-browser-errors-test"),
  providerId: "custom",
  modelId: "my-model-id",
  apiKey: FAKE_API_KEY,
  cwd: "/tmp",
};

/** Longest allowed stderr tail, per the diagnostics contract. */
const STDERR_LIMIT = MAX_STDERR_TAIL;

function stdout(...events: unknown[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

/* ------------------------------------------------------------------------- *
 * 16. Summariser classification, safe truncation and unsafe fallback.
 * ------------------------------------------------------------------------- */

realLog("error summariser");

type Row = {
  name: string;
  failure: RuntimeFailure;
  context?: RuntimeFailureContext;
  error: string;
};

const ROWS: Row[] = [
  {
    name: "provider/setup missing",
    failure: { kind: "setup_required" },
    error: "Setup required — configure a provider in Settings",
  },
  {
    name: "API key missing",
    failure: { kind: "api_key_missing" },
    error: "API key missing — add it in Settings",
  },
  {
    name: "stored key cannot be decrypted",
    failure: { kind: "api_key_unreadable" },
    error: "Stored API key unreadable — re-enter it",
  },
  {
    name: "unreadable settings",
    failure: { kind: "settings_unreadable" },
    error: "Settings could not be read",
  },
  {
    name: "invalid settings with our own message",
    failure: {
      kind: "settings_invalid",
      field: "baseUrl",
      message: 'Base URL must use http or https (received "ftp:").',
    },
    error: 'Base URL must use http or https (received "ftp:").',
  },
  {
    name: "invalid settings with a field only",
    failure: { kind: "settings_invalid", field: "modelId" },
    error: "Settings invalid — check the modelId",
  },
  {
    name: "invalid settings with nothing else",
    failure: { kind: "settings_invalid" },
    error: "Provider settings are invalid",
  },
  {
    name: "configuration write failure",
    failure: { kind: "config_write_failed" },
    error: "Could not write agent configuration",
  },
  {
    name: "runtime preparation failure",
    failure: { kind: "prepare_failed" },
    error: "Could not prepare the agent runtime",
  },
  {
    name: "process startup failure",
    failure: { kind: "start_failed" },
    error: "Could not start the agent runtime",
  },
  {
    name: "pnpm spawn failure with ENOENT",
    failure: { kind: "spawn", errno: "ENOENT" },
    error: "pnpm not found on PATH",
  },
  {
    name: "child error with ENOENT",
    failure: { kind: "child_error", errno: "ENOENT" },
    error: "pnpm not found on PATH",
  },
  {
    name: "spawn failure with another errno",
    failure: { kind: "spawn", errno: "EACCES" },
    error: "Agent could not start (EACCES)",
  },
  {
    name: "spawn failure with no errno",
    failure: { kind: "spawn" },
    error: "Agent could not be started",
  },
  {
    name: "unexpected exit with a numeric code",
    failure: { kind: "exit", code: 1, signal: null },
    error: "Agent exited (code 1)",
  },
  {
    name: "unexpected exit with code 0 is still unexpected",
    failure: { kind: "exit", code: 0, signal: null },
    error: "Agent exited (code 0)",
  },
  {
    name: "unexpected exit with a signal",
    failure: { kind: "exit", code: null, signal: "SIGKILL" },
    error: "Agent killed (SIGKILL)",
  },
  {
    name: "unexpected exit with neither code nor signal",
    failure: { kind: "exit", code: null, signal: null },
    error: "Agent process exited unexpectedly",
  },
  {
    name: "exit whose stderr names an authentication rejection",
    failure: { kind: "exit", code: 1, signal: null },
    context: {
      stderrTail:
        'Error: 401: {"message":"Incorrect API key provided: ' +
        FAKE_API_KEY +
        '"}',
    },
    error: "API key rejected by endpoint",
  },
  {
    name: "exit whose stderr names an unknown model",
    failure: { kind: "exit", code: 1, signal: null },
    context: {
      stderrTail:
        'Error: Model "not-in-the-file" not found for provider "custom".',
      modelId: "my-model-id",
    },
    error: "Model not found: my-model-id",
  },
  {
    name: "failed stdin write",
    failure: { kind: "write_failed" },
    error: "Lost connection to the agent",
  },
  {
    name: "malformed RPC stream",
    failure: { kind: "malformed_rpc" },
    error: "Agent stopped responding",
  },
  {
    name: "Pi rejected a command with a 401",
    failure: {
      kind: "rpc_response",
      message:
        '401: {"message":"Incorrect API key provided: ' + FAKE_API_KEY + '"}',
    },
    error: "API key rejected by endpoint",
  },
  {
    name: "Pi rejected a command with an unknown model",
    failure: { kind: "rpc_response", message: "Model not found: custom/xyz" },
    context: { modelId: "my-model-id" },
    error: "Model not found: my-model-id",
  },
  {
    name: "Pi rejected a command with no error text",
    failure: { kind: "rpc_response", message: null },
    error: "Agent rejected the command",
  },
  {
    name: "provider 401 as Pi 1.1.0 actually emits it",
    failure: {
      kind: "provider_error",
      message:
        '401: {"message":"Incorrect API key provided: ' +
        FAKE_API_KEY +
        '","type":"invalid_request_error","code":"invalid_api_key"}',
    },
    error: "API key rejected by endpoint",
  },
  {
    name: "provider 404 model_not_found as Pi 1.1.0 actually emits it",
    failure: {
      kind: "provider_error",
      message:
        '404: {"message":"The model `my-model-id` does not exist or you do ' +
        'not have access to it.","code":"model_not_found"}',
    },
    context: { modelId: "my-model-id" },
    error: "Model not found: my-model-id",
  },
  {
    name: "unclassified provider body is discarded, not shown",
    failure: {
      kind: "provider_error",
      message: `${SYSTEM_SENTINEL} ${PROMPT_SENTINEL}`,
    },
    error: FALLBACK_ERROR,
  },
  {
    name: "untrusted text is discarded",
    failure: { kind: "unknown", message: PROMPT_SENTINEL },
    error: FALLBACK_ERROR,
  },
  {
    name: "untrusted text with no message",
    failure: { kind: "unknown", message: null },
    error: FALLBACK_ERROR,
  },
  {
    name: "trusted text is summarised, not discarded",
    failure: {
      kind: "unknown",
      message: "Base URL must include a host.",
      trusted: true,
    },
    error: "Base URL must include a host.",
  },
];

for (const row of ROWS) {
  await check(`summarises: ${row.name}`, () => {
    const summary = ensureSafeErrorMessage(
      summarizeRuntimeError(row.failure, {
        modelId: "my-model-id",
        secrets: [FAKE_API_KEY],
        ...row.context,
      }),
    );

    assert.equal(summary.error, row.error);
    assert.ok(summary.error.length > 0, "error must be non-empty");
    assert.ok(
      summary.error.length <= MAX_ERROR_LENGTH,
      `error must be bounded, got ${summary.error.length}`,
    );

    if (summary.detail !== null) {
      assert.ok(
        summary.detail.length <= MAX_DETAIL_LENGTH,
        `detail must be bounded, got ${summary.detail.length}`,
      );
    }

    for (const sentinel of ALL_SENTINELS) {
      assert.ok(!summary.error.includes(sentinel), `error leaked ${sentinel}`);

      if (summary.detail !== null) {
        assert.ok(
          !summary.detail.includes(sentinel),
          `detail leaked ${sentinel}`,
        );
      }
    }
  });
}

await check("every failure kind produces a non-empty bounded message", () => {
  const everything: RuntimeFailure[] = [
    { kind: "setup_required" },
    { kind: "api_key_missing" },
    { kind: "settings_unreadable" },
    { kind: "api_key_unreadable" },
    { kind: "settings_invalid" },
    { kind: "config_write_failed" },
    { kind: "prepare_failed" },
    { kind: "start_failed" },
    { kind: "spawn" },
    { kind: "child_error" },
    { kind: "exit", code: null, signal: null },
    { kind: "rpc_response" },
    { kind: "provider_error" },
    { kind: "write_failed" },
    { kind: "malformed_rpc" },
    { kind: "unknown" },
  ];

  for (const failure of everything) {
    const summary = ensureSafeErrorMessage(summarizeRuntimeError(failure));

    assert.ok(summary.error.length > 0, `${failure.kind} produced no message`);
    assert.ok(summary.error.length <= MAX_ERROR_LENGTH);
  }
});

await check("an overlong trusted message is truncated with an ellipsis", () => {
  const summary = summarizeRuntimeError({
    kind: "unknown",
    message: "a".repeat(500),
    trusted: true,
  });

  assert.equal(summary.error.length, MAX_ERROR_LENGTH);
  assert.ok(summary.error.endsWith("…"));
  assert.ok(!summary.error.includes("\n"), "summary must be single-line");
});

await check("control characters cannot reach a summary", () => {
  const summary = summarizeRuntimeError({
    kind: "unknown",
    message: "line one\nline two\u0007line three\u001b[31mred",
    trusted: true,
  });

  assert.equal(summary.error, "line one line two line three [31mred");
  assert.equal(normalizeToOneLine("\n\r\t\u0000"), "");
});

await check("the API key is scrubbed before truncation, not after", () => {
  // The key sits inside the first 80 characters; a naive
  // truncate-then-redact would leave the tail of it on screen.
  const message = `${"x".repeat(20)} ${FAKE_API_KEY} ${"y".repeat(200)}`;

  const summary = summarizeRuntimeError({
    kind: "unknown",
    message,
    trusted: true,
  });

  assert.ok(!summary.error.includes(FAKE_API_KEY));
  assert.ok(summary.error.includes("[redacted]"));
  assert.equal(summary.error.length, MAX_ERROR_LENGTH);
});

await check("bearer credentials and key shapes are redacted", () => {
  const cases = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA",
    "api_key=sk-something-else-entirely",
    '"apiKey": "value-of-the-key-here"',
    "token: deadbeefdeadbeefdeadbeef",
    "sk-abcdef1234567890-should-go",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature-part",
  ];

  for (const value of cases) {
    const out = scrubCredentials(value, [FAKE_API_KEY]);

    assert.ok(!out.includes("abcdefghijklmnopqrstuvwxyz"), value);
    assert.ok(!out.includes("dXNlcjpwYXNzd29yZA"), value);
    assert.ok(!out.includes("sk-something-else-entirely"), value);
    assert.ok(!out.includes("value-of-the-key-here"), value);
    assert.ok(!out.includes("deadbeefdeadbeefdeadbeef"), value);
    assert.ok(!out.includes("sk-abcdef1234567890"), value);
    assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9"), value);
  }
});

await check("a model id is bounded and normalised in the summary", () => {
  const summary = summarizeRuntimeError(
    { kind: "rpc_response", message: "Model not found: whatever" },
    { modelId: `evil\n${"m".repeat(300)}` },
  );

  assert.ok(summary.error.startsWith("Model not found: "));
  assert.ok(summary.error.length <= MAX_ERROR_LENGTH);
  assert.ok(!summary.error.includes("\n"));
});

await check("ensureSafeErrorMessage repairs an empty or oversized summary", () => {
  assert.equal(
    ensureSafeErrorMessage({ error: "   ", detail: null }).error,
    FALLBACK_ERROR,
  );

  const repaired = ensureSafeErrorMessage({
    error: "e".repeat(500),
    detail: "d".repeat(500),
  });

  assert.equal(repaired.error.length, MAX_ERROR_LENGTH);
  assert.equal(repaired.detail!.length, MAX_DETAIL_LENGTH);
});

/* ------------------------------------------------------------------------- *
 * Renderer view state: revision ordering and the status-to-view mapping.
 * ------------------------------------------------------------------------- */

realLog("renderer view state");

function snap(
  revision: number,
  status: AgentRuntimeSnapshot["status"],
  error: string | null = null,
  detail: string | null = null,
): AgentRuntimeSnapshot {
  return { revision, status, error, detail };
}

await check("the initial stopped snapshot (revision 0) is accepted", () => {
  const next = applyRuntimeSnapshot(
    INITIAL_RUNTIME_VIEW_STATE,
    snap(0, "stopped"),
  );

  assert.equal(next.appliedRevision, 0);
  assert.equal(next.status, "stopped");
  assert.equal(next.error, null);
  assert.equal(next.detail, null);
});

await check("a newer snapshot is applied", () => {
  const next = applyRuntimeSnapshot(
    applyRuntimeSnapshot(INITIAL_RUNTIME_VIEW_STATE, snap(0, "starting")),
    snap(4, "error", "API key rejected by endpoint", "some detail"),
  );

  assert.equal(next.appliedRevision, 4);
  assert.equal(next.status, "error");
  assert.equal(next.error, "API key rejected by endpoint");
  assert.equal(next.detail, "some detail");
});

await check("5. a stale pulled snapshot cannot overwrite a newer event", () => {
  // The exact startup race: an event at revision 5 arrives, then the
  // pull issued before it resolves with revision 4.
  const afterEvent = applyRuntimeSnapshot(
    INITIAL_RUNTIME_VIEW_STATE,
    snap(
      5,
      "error",
      "Agent exited (code 1)",
      "stderr captured (12 chars) but withheld",
    ),
  );

  const afterStalePull = applyRuntimeSnapshot(afterEvent, snap(4, "ready"));

  assert.equal(afterStalePull, afterEvent, "state must be untouched");
  assert.equal(afterStalePull.status, "error");
  assert.equal(afterStalePull.error, "Agent exited (code 1)");
  assert.equal(afterStalePull.appliedRevision, 5);
});

await check("a pull carrying the latest revision is applied", () => {
  const next = applyRuntimeSnapshot(
    INITIAL_RUNTIME_VIEW_STATE,
    snap(9, "error", "Stored API key unreadable — re-enter it", null),
  );

  assert.equal(next.status, "error");
  assert.equal(next.error, "Stored API key unreadable — re-enter it");
  assert.equal(next.appliedRevision, 9);
});

await check("a non-error snapshot clears both error fields", () => {
  const failed = applyRuntimeSnapshot(
    INITIAL_RUNTIME_VIEW_STATE,
    snap(2, "error", "some reason", "some detail"),
  );

  const recovered = applyRuntimeSnapshot(failed, snap(3, "ready"));

  assert.equal(recovered.error, null);
  assert.equal(recovered.detail, null);
  assert.equal(recovered.status, "ready");
});

await check('the status view never renders a bare "Error"', () => {
  const empty = statusView({
    isConfigured: true,
    showSetupMessage: false,
    status: "error",
    error: "",
    detail: null,
  });

  assert.notEqual(empty.text, "Error");
  assert.equal(empty.text, "Agent encountered an unexpected error");
  assert.equal(empty.tone, "error");

  const missing = statusView({
    isConfigured: true,
    showSetupMessage: false,
    status: "error",
    error: null,
    detail: null,
  });

  assert.equal(missing.text, "Agent encountered an unexpected error");
});

await check("the status view shows the summary and tooltips the detail", () => {
  const view = statusView({
    isConfigured: true,
    showSetupMessage: false,
    status: "error",
    error: "API key rejected by endpoint",
    detail: "The endpoint rejected the request as unauthorised.",
  });

  assert.equal(view.text, "API key rejected by endpoint");
  assert.equal(
    view.tooltip,
    "The endpoint rejected the request as unauthorised.",
  );
});

await check("the tooltip falls back to the summary when there is no detail", () => {
  const view = statusView({
    isConfigured: true,
    showSetupMessage: false,
    status: "error",
    error: "Agent exited (code 1)",
    detail: null,
  });

  assert.equal(view.tooltip, "Agent exited (code 1)");
});

await check("17. the title clears after a recovery transition", () => {
  const before = statusView({
    isConfigured: true,
    showSetupMessage: false,
    status: "error",
    error: "Agent exited (code 1)",
    detail: "some detail",
  });

  for (const state of ["ready", "starting", "stopped", "working"] as const) {
    const after = statusView({
      isConfigured: true,
      showSetupMessage: false,
      status: state,
      error: null,
      detail: null,
    });

    assert.equal(after.tooltip, null, `tooltip not cleared for ${state}`);
    assert.notEqual(after.text, "Error");
  }

  assert.notEqual(before.tooltip, null, "sanity");
});

await check("the setup state clears the title rather than reusing a reason", () => {
  const view = statusView({
    isConfigured: false,
    showSetupMessage: true,
    status: "error",
    error: "Setup required — configure a provider in Settings",
    detail: "No usable base URL, API key and model ID are stored.",
  });

  assert.equal(view.text, "Setup required");
  assert.equal(view.tooltip, null);
});

/* ------------------------------------------------------------------------- *
 * Snapshot contract: revisions, invariants, event completeness.
 * ------------------------------------------------------------------------- */

realLog("snapshot contract");

await check("the initial snapshot is stopped at revision 0 with no reason", () => {
  const service = new AgentRuntimeService(makeRecorder().spawnPi, 20);

  assert.deepEqual(service.getSnapshot(), {
    status: "stopped",
    error: null,
    detail: null,
    revision: 0,
  });
});

await check("every emitted event carries a complete snapshot", () => {
  const { spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  const snapshots: AgentRuntimeSnapshot[] = [];

  service.subscribe((event) => {
    assert.equal(event.type, "agent_status");

    assert.deepEqual(Object.keys(event.snapshot).sort(), [
      "detail",
      "error",
      "revision",
      "status",
    ]);

    snapshots.push(event.snapshot);
  });

  service.start(CONFIG);
  service.failStartup({ kind: "api_key_unreadable" });
  service.stop();

  assert.ok(snapshots.length >= 3);

  for (let i = 1; i < snapshots.length; i += 1) {
    assert.ok(
      snapshots[i].revision > snapshots[i - 1].revision,
      "revisions must increase monotonically",
    );
  }

  for (const snapshot of snapshots) {
    if (snapshot.status === "error") {
      assert.ok(snapshot.error && snapshot.error.length > 0);
    } else {
      assert.equal(snapshot.error, null);
      assert.equal(snapshot.detail, null);
    }
  }
});

await check("an unchanged transition does not bump the revision", () => {
  const { spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  const revisions: number[] = [];

  service.subscribe((event) => revisions.push(event.snapshot.revision));

  service.start(CONFIG);
  service.failStartup({ kind: "api_key_missing" });

  const afterFirst = service.getSnapshot().revision;

  service.failStartup({ kind: "api_key_missing" });

  assert.equal(service.getSnapshot().revision, afterFirst);
  assert.equal(revisions.length, 2, "identical failure must not re-emit");
});

await check("4. a failed startup is recoverable from a pulled snapshot", () => {
  const { spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  service.failStartup({ kind: "api_key_unreadable" });

  // Exactly what agent:get-snapshot hands the renderer on load.
  const pulled = service.getSnapshot();

  assert.equal(pulled.status, "error");
  assert.equal(pulled.error, "Stored API key unreadable — re-enter it");
  assert.ok(pulled.detail && pulled.detail.includes("decrypted"));

  const view = applyRuntimeSnapshot(INITIAL_RUNTIME_VIEW_STATE, pulled);

  assert.equal(view.error, "Stored API key unreadable — re-enter it");
});

await check("entering ready clears any previous error and detail", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  service.start(CONFIG);

  await sleep(40);

  children[0].emitStdout(
    stdout(
      { id: "x", type: "response", command: "prompt", success: true },
      { type: "agent_settled", aborted: false },
    ),
  );

  const settled = service.getSnapshot();

  assert.equal(settled.status, "ready");
  assert.equal(settled.error, null);
  assert.equal(settled.detail, null);

  service.stop();
});

/* ------------------------------------------------------------------------- *
 * 5-9. Lifecycle: exits, intentional stops, superseded children.
 * ------------------------------------------------------------------------- */

realLog("process lifecycle and failures");

/**
 * Drive a service into `ready` through the real event sequence.
 *
 * Starts the service itself, so the child must be looked up after the
 * call rather than before it.
 */
async function reachReady(
  service: AgentRuntimeService,
  children: FakeChild[],
): Promise<FakeChild> {
  service.start(CONFIG);

  await sleep(40); // startup timer -> opening_browser + the startup prompt

  const child = children[0];

  child.emitStdout(
    stdout(
      { id: "startup-1", type: "response", command: "prompt", success: true },
      { type: "agent_start" },
      { type: "agent_settled", aborted: false },
    ),
  );

  assert.equal(service.getStatus(), "ready");

  return child;
}

for (const target of ["starting", "opening_browser", "working", "ready"] as const) {
  await check(`6. an unexpected exit from "${target}" becomes an error`, async () => {
    const { children, spawnPi } = makeRecorder();
    const service = new AgentRuntimeService(spawnPi, 60_000);

    service.start(CONFIG);
    const child = children[0];

    if (target !== "starting") {
      await sleep(40); // opening_browser + startup prompt

      child.emitStdout(
        stdout(
          { id: "s", type: "response", command: "prompt", success: true },
          { type: "agent_start" },
        ),
      );

      if (target !== "opening_browser") {
        child.emitStdout(stdout({ type: "agent_settled", aborted: false }));
        assert.equal(service.getStatus(), "ready");
      }
    }

    if (target === "working") {
      service.send("do something");
      assert.equal(service.getStatus(), "working");
    }

    child.emitExit(1, null);

    const snapshot = service.getSnapshot();

    assert.equal(snapshot.status, "error");
    assert.equal(snapshot.error, "Agent exited (code 1)");
  });
}

await check("7. exit code, signal and neither are all distinguished", async () => {
  const cases: Array<[number | null, string | null, string]> = [
    [1, null, "Agent exited (code 1)"],
    [0, null, "Agent exited (code 0)"],
    [null, "SIGKILL", "Agent killed (SIGKILL)"],
    [null, null, "Agent process exited unexpectedly"],
  ];

  for (const [code, signal, expected] of cases) {
    const { children, spawnPi } = makeRecorder();
    const service = new AgentRuntimeService(spawnPi, 20);

    service.start(CONFIG);
    children[0].emitExit(code, signal);

    assert.equal(service.getSnapshot().error, expected);
  }
});

await check("7. stderr is classified but never echoed on an unexpected exit", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  service.start(CONFIG);

  const child = children[0];

  child.emitStderr(
    `Error: 401: {"message":"Incorrect API key provided: ${FAKE_API_KEY}"}`,
  );
  child.emitExit(1, null);

  const snapshot = service.getSnapshot();

  assert.equal(snapshot.error, "API key rejected by endpoint");
  assert.ok(snapshot.detail && snapshot.detail.includes("stderr captured"));
  assert.ok(!JSON.stringify(snapshot).includes(FAKE_API_KEY));
  assert.ok(!JSON.stringify(snapshot).includes("Incorrect API key"));
});

await check("8. an intentional stop produces stopped with both fields null", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  service.start(CONFIG);
  service.failStartup({ kind: "write_failed" });

  assert.equal(service.getSnapshot().status, "error");

  service.stop();

  const snapshot = service.getSnapshot();

  assert.equal(snapshot.status, "stopped");
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.detail, null);
  assert.equal(children[0].stdin.ended, true, "stdin must be closed");
  assert.equal(children[0].killed, true, "child must be signalled");
});

await check("8. an intentional stop with no child attached still reports stopped", () => {
  const { spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  service.failStartup({ kind: "setup_required" });
  assert.equal(service.getSnapshot().status, "error");

  service.stop();

  const snapshot = service.getSnapshot();

  assert.equal(snapshot.status, "stopped");
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.detail, null);
});

await check("8. a restart clears the previous error before the new run", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  service.start(CONFIG);
  service.failStartup({ kind: "provider_error", message: "401: nope" });

  assert.equal(service.getSnapshot().status, "error");

  service.restart(CONFIG);

  const snapshot = service.getSnapshot();

  assert.equal(snapshot.status, "starting");
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.detail, null);
  assert.equal(children.length, 2);

  service.stop();
});

await check("9. a superseded child's handlers cannot touch the replacement", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  service.start(CONFIG);
  const old = children[0];

  service.stop();
  service.start(CONFIG);
  const current = children[1];

  const before = service.getSnapshot();
  const diagnosticsBefore = service.getDiagnostics();

  // Everything a stale child could possibly emit.
  old.emitStdout(stdout({ type: "agent_settled" }));
  old.emitStdout('{"half a line without a newline');
  old.emitStderr("stale stderr that must be dropped");
  old.emitSpawnError("ENOENT");
  old.emitExit(1, null);
  old.emitClose(1, null);

  await sleep(20);

  assert.equal(service.getStatus(), before.status, "status changed");
  assert.equal(
    service.getSnapshot().revision,
    before.revision,
    "revision changed",
  );
  assert.equal(
    service.getDiagnostics().stderrTailChars,
    diagnosticsBefore.stderrTailChars,
    "a superseded child appended to the stderr tail",
  );
  assert.equal(current.killed, false, "the live child must be untouched");

  service.stop();
});

await check("a repeated start() never spawns a second process", () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  service.start(CONFIG);
  service.start(CONFIG);
  service.start(CONFIG);

  assert.equal(children.length, 1);

  service.stop();
});

/* ------------------------------------------------------------------------- *
 * 10. Synchronous spawn exceptions and asynchronous ENOENT.
 * ------------------------------------------------------------------------- */

realLog("spawn failures");

await check("10. a synchronous spawn exception reports pnpm missing", () => {
  const service = new AgentRuntimeService(() => {
    throw Object.assign(new Error(`spawn pnpm ENOENT for ${FAKE_API_KEY}`), {
      code: "ENOENT",
    });
  }, 20);

  service.start(CONFIG);

  const snapshot = service.getSnapshot();

  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.error, "pnpm not found on PATH");
  assert.ok(!JSON.stringify(snapshot).includes(FAKE_API_KEY));
  assert.ok(!JSON.stringify(snapshot).includes("spawn pnpm ENOENT"));
});

await check("10. a synchronous spawn exception with another errno names the code", () => {
  const service = new AgentRuntimeService(() => {
    throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
  }, 20);

  service.start(CONFIG);

  assert.equal(service.getSnapshot().error, "Agent could not start (EACCES)");
});

await check("10. an async ENOENT is reported once and leaves the runtime retryable", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  service.start(CONFIG);
  const child = children[0];

  child.emitSpawnError("ENOENT");

  const afterError = service.getSnapshot();

  assert.equal(afterError.status, "error");
  assert.equal(afterError.error, "pnpm not found on PATH");

  // Node follows an async spawn failure with exit and/or close. Both
  // must be inert: the specific failure is the one that gets kept.
  child.emitExit(null, null);
  child.emitClose(null, null);

  await sleep(10);

  assert.equal(service.getSnapshot().error, "pnpm not found on PATH");
  assert.equal(
    service.getSnapshot().revision,
    afterError.revision,
    "the same failed launch was reported twice",
  );

  // Not stuck in "starting", not attached to a dead child: retry works.
  service.start(CONFIG);

  assert.equal(children.length, 2);
  assert.equal(service.getStatus(), "starting");

  service.stop();
});

/* ------------------------------------------------------------------------- *
 * 11-12. Diagnostics are bounded and scoped to one child.
 * ------------------------------------------------------------------------- */

realLog("diagnostics");

await check("11. the stderr tail is bounded", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  service.start(CONFIG);

  const child = children[0];

  for (let i = 0; i < 10; i += 1) {
    child.emitStderr("e".repeat(1000));
  }

  assert.equal(service.getDiagnostics().stderrTailChars, STDERR_LIMIT);

  service.stop();
});

await check("11. only the current child's stderr is retained", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  service.start(CONFIG);
  children[0].emitStderr("first child noise");

  service.stop();

  assert.equal(
    service.getDiagnostics().stderrTailChars,
    0,
    "an intentional stop clears the tail",
  );

  service.start(CONFIG);
  children[1].emitStderr("second child noise");

  assert.equal(
    service.getDiagnostics().stderrTailChars,
    "second child noise".length,
    "the replacement must not inherit the previous tail",
  );

  service.stop();
});

await check("12. a partial stdout line cannot cross into the next child", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  service.start(CONFIG);
  children[0].emitStdout('{"type":"agent_start"}\n{"type":"mess');

  assert.ok(service.getDiagnostics().pendingStdoutChars > 0);

  service.stop();
  service.start(CONFIG);

  assert.equal(
    service.getDiagnostics().pendingStdoutChars,
    0,
    "the half-read line must not be concatenated with the new child's output",
  );

  service.stop();
});

await check("malformed stdout becomes a safe protocol error, never a log line", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  service.start(CONFIG);

  const child = children[0];
  const before = captured.length;

  for (let i = 0; i < 8; i += 1) {
    child.emitStdout(`not json ${PROMPT_SENTINEL}\n`);
  }

  const snapshot = service.getSnapshot();

  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.error, "Agent stopped responding");

  const logged = captured.slice(before).join("\n");

  assert.ok(!logged.includes(PROMPT_SENTINEL), "a malformed line was logged");
  assert.ok(!logged.includes("not json"));

  service.stop();
});

await check("a few tolerated non-JSON lines do not break the runtime", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  service.start(CONFIG);

  const child = children[0];

  child.emitStdout("pnpm bootstrap noise\n");
  child.emitStdout(stdout({ type: "agent_start" }));

  assert.equal(service.getDiagnostics().malformedLines, 1);
  assert.notEqual(service.getStatus(), "error");

  service.stop();
});

/* ------------------------------------------------------------------------- *
 * 13. Pi RPC failures.
 * ------------------------------------------------------------------------- */

realLog("Pi RPC failures");

await check("13. a rejected 401 response becomes the authentication summary", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  service.start(CONFIG);

  await sleep(40);

  children[0].emitStdout(
    stdout({
      id: "p1",
      type: "response",
      command: "prompt",
      success: false,
      error: `401: {"message":"Incorrect API key provided: ${FAKE_API_KEY}"}`,
    }),
  );

  const snapshot = service.getSnapshot();

  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.error, "API key rejected by endpoint");
  assert.ok(!JSON.stringify(snapshot).includes(FAKE_API_KEY));

  service.stop();
});

await check("13. a rejected unknown-model response names the configured model", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  service.start(CONFIG);

  await sleep(40);

  children[0].emitStdout(
    stdout({
      id: "p1",
      type: "response",
      command: "set_model",
      success: false,
      error: "Model not found: custom/not-the-configured-one",
    }),
  );

  assert.equal(service.getSnapshot().error, "Model not found: my-model-id");

  service.stop();
});

await check("13. a response with no error text still yields a non-empty error", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  service.start(CONFIG);

  await sleep(40);

  children[0].emitStdout(
    stdout({ id: "p1", type: "response", command: "steer", success: false }),
  );

  const snapshot = service.getSnapshot();

  assert.equal(snapshot.status, "error");
  assert.ok(snapshot.error && snapshot.error.length > 0);
  assert.notEqual(snapshot.error, "Error");

  service.stop();
});

await check("13. the runtime does not stay 'working' after a rejection", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  await reachReady(service, children);

  service.send("do something");
  assert.equal(service.getStatus(), "working");

  children[0].emitStdout(
    stdout({
      id: "p1",
      type: "response",
      command: "prompt",
      success: false,
      error: "401: unauthorized",
    }),
  );

  assert.equal(service.getStatus(), "error");

  service.stop();
});

await check("a mid-run provider 401 is reported, not silently swallowed", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  service.start(CONFIG);

  await sleep(40);

  /*
   * The shape Pi 1.1.0 actually produces, verified against the installed
   * binary talking to a loopback endpoint that answers 401: the prompt
   * is accepted, the HTTP call fails, and the turn closes with
   * stopReason "error". Nothing in the `response` channel reports it and
   * the process stays alive.
   */
  children[0].emitStdout(
    stdout(
      { id: "startup-1", type: "response", command: "prompt", success: true },
      { type: "agent_start" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage:
            `401: {"message":"Incorrect API key provided: ${FAKE_API_KEY}",` +
            '"type":"invalid_request_error","code":"invalid_api_key"}',
        },
      },
      { type: "agent_end", messages: [] },
      { type: "agent_settled", aborted: false },
    ),
  );

  const snapshot = service.getSnapshot();

  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.error, "API key rejected by endpoint");
  assert.ok(!JSON.stringify(snapshot).includes(FAKE_API_KEY));
  assert.ok(!JSON.stringify(snapshot).includes("invalid_request_error"));

  service.stop();
});

await check("agent_settled does not erase a still-relevant provider failure", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  service.start(CONFIG);

  await sleep(40);

  children[0].emitStdout(
    stdout(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "401: unauthorized",
        },
      },
      { type: "agent_settled", aborted: false },
    ),
  );

  const snapshot = service.getSnapshot();

  assert.equal(snapshot.status, "error", "settled erased the failure");
  assert.equal(snapshot.error, "API key rejected by endpoint");

  service.stop();
});

await check("a healthy turn after a failure does clear it", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  service.start(CONFIG);

  await sleep(40);

  children[0].emitStdout(
    stdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Connection error.",
      },
    }),
  );

  assert.equal(service.getSnapshot().status, "error");

  // Pi's own retry succeeds.
  children[0].emitStdout(
    stdout(
      { type: "agent_start" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stopReason: "stop",
        },
      },
      { type: "agent_settled", aborted: false },
    ),
  );

  const snapshot = service.getSnapshot();

  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.detail, null);

  service.stop();
});

await check("18. a tool failure does not change the runtime status", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  await reachReady(service, children);

  const before = service.getSnapshot();

  children[0].emitStdout(
    stdout(
      {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "browser_click",
        isError: true,
        durationMs: 12,
        result: {
          content: [
            {
              type: "text",
              text: `### Error\nBrowser "chromium" is not installed\n${TOOL_RESULT_SENTINEL}`,
            },
          ],
          details: {},
        },
      },
      { type: "agent_settled", aborted: false },
    ),
  );

  const after = service.getSnapshot();

  assert.equal(after.status, "ready", "a tool error became a runtime error");
  assert.equal(after.revision, before.revision);
  assert.ok(!JSON.stringify(after).includes(TOOL_RESULT_SENTINEL));

  service.stop();
});

await check("an extension error does not change the runtime status", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  await reachReady(service, children);

  const before = service.getSnapshot();

  children[0].emitStdout(
    stdout({
      type: "extension_error",
      extensionPath: "builtin:mcp",
      event: "session_start",
      error: `MCP server failed: ${SYSTEM_SENTINEL}`,
    }),
  );

  assert.equal(service.getStatus(), "ready");
  assert.equal(service.getSnapshot().revision, before.revision);

  service.stop();
});

/* ------------------------------------------------------------------------- *
 * 14. Failed writes.
 * ------------------------------------------------------------------------- */

realLog("write failures");

await check("14. a failed send transitions to error before rejecting", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  await reachReady(service, children);

  // Simulate a closed pipe.
  children[0].stdin.writable = false;

  let thrown: unknown = null;

  try {
    service.send("a prompt that must not leak");
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown, "send must reject");
  assert.ok(!String(thrown).includes("a prompt that must not leak"));

  const snapshot = service.getSnapshot();

  assert.equal(snapshot.status, "error", "the UI would still look ready");
  assert.equal(snapshot.error, "Lost connection to the agent");
  assert.ok(!JSON.stringify(snapshot).includes("a prompt that must not leak"));

  service.stop();
});

await check("14. a synchronous write throw is reported and rethrown safely", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  await reachReady(service, children);

  children[0].stdin.throwOnWrite = true;

  assert.throws(
    () => service.send("prompt sentinel"),
    /Could not deliver the command to the agent/,
  );

  assert.equal(service.getSnapshot().status, "error");
  assert.equal(service.getSnapshot().error, "Lost connection to the agent");

  service.stop();
});

await check("14. an async stdin error is reported", async () => {
  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  await reachReady(service, children);

  children[0].stdin.emit(
    "error",
    Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
  );

  assert.equal(service.getSnapshot().status, "error");
  assert.equal(service.getSnapshot().error, "Lost connection to the agent");

  service.stop();
});

await check("send and steer reject in the wrong state without failing the runtime", async () => {
  const { spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  service.start(CONFIG);

  assert.throws(() => service.send("hi"), /not ready/);
  assert.throws(() => service.steer("hi"), /not working/);

  assert.equal(service.getStatus(), "starting");
  assert.equal(service.getSnapshot().error, null);

  service.stop();
});

/* ------------------------------------------------------------------------- *
 * 15. Secrets and sentinels never reach a snapshot, an event or a log.
 * ------------------------------------------------------------------------- */

realLog("secret and content containment");

await check("15. no sentinel reaches a snapshot, an event or a log line", async () => {
  const before = captured.length;

  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  const events: string[] = [];

  service.subscribe((event) => {
    events.push(JSON.stringify(event));
  });

  service.start(CONFIG);

  await sleep(40);

  children[0].emitStderr(`stderr with ${FAKE_API_KEY} and ${SYSTEM_SENTINEL}`);

  children[0].emitStdout(
    stdout(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: TOOL_RESULT_SENTINEL }],
          stopReason: "error",
          errorMessage:
            `401: {"message":"Incorrect API key provided: ${FAKE_API_KEY}",` +
            `"note":"${PROMPT_SENTINEL}"}`,
        },
      },
      { type: "agent_settled", aborted: false },
      {
        type: "agent_end",
        messages: [
          { role: "system", content: "", sections: { preamble: SYSTEM_SENTINEL } },
        ],
      },
    ),
  );

  children[0].emitExit(1, null);

  const snapshotJson = JSON.stringify(service.getSnapshot());
  const eventsJson = events.join("\n");
  const logs = captured.slice(before).join("\n");

  for (const sentinel of ALL_SENTINELS) {
    assert.ok(!snapshotJson.includes(sentinel), `snapshot leaked ${sentinel}`);
    assert.ok(!eventsJson.includes(sentinel), `event leaked ${sentinel}`);
    assert.ok(!logs.includes(sentinel), `log leaked ${sentinel}`);
  }

  // The message the user does see is a fixed classification, never the
  // provider body the sentinels came from.
  assert.equal(service.getSnapshot().error, "API key rejected by endpoint");
});

await check("15. a prompt sent to the agent is never logged or echoed", async () => {
  const before = captured.length;

  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 60_000);

  await reachReady(service, children);

  const secretPrompt = `${PROMPT_SENTINEL} please do the thing`;

  service.send(secretPrompt);

  children[0].stdin.throwOnWrite = true;

  try {
    service.steer(secretPrompt);
  } catch {
    // Expected: the write fails and the runtime reports it.
  }

  const logs = captured.slice(before).join("\n");

  assert.ok(!logs.includes(PROMPT_SENTINEL), "the prompt reached the logs");
  assert.ok(!logs.includes(secretPrompt));
  assert.ok(
    !JSON.stringify(service.getSnapshot()).includes(PROMPT_SENTINEL),
    "the prompt reached the snapshot",
  );

  service.stop();
});

await check("15. spawn arguments are logged redacted", () => {
  const before = captured.length;

  const { spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  service.start(CONFIG);

  const logs = captured.slice(before).join("\n");

  assert.ok(!logs.includes(FAKE_API_KEY));
  assert.ok(logs.includes("***"), "the redaction marker should still be visible");

  service.stop();
});

await check("no lifecycle log line contains a Pi event payload", async () => {
  const before = captured.length;

  const { children, spawnPi } = makeRecorder();
  const service = new AgentRuntimeService(spawnPi, 20);

  service.start(CONFIG);

  children[0].emitStdout(
    stdout(
      {
        type: "message_start",
        message: { role: "system", sections: { preamble: SYSTEM_SENTINEL } },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", text: TOOL_RESULT_SENTINEL },
      },
      { type: "turn_end", message: { content: [{ text: PROMPT_SENTINEL }] } },
      { type: "agent_start" },
    ),
  );

  const logs = captured.slice(before).join("\n");

  assert.ok(
    logs.includes("[PI EVENT] agent_start"),
    "lifecycle logging should remain",
  );
  assert.ok(!logs.includes(SYSTEM_SENTINEL));
  assert.ok(!logs.includes(TOOL_RESULT_SENTINEL));
  assert.ok(!logs.includes(PROMPT_SENTINEL));

  service.stop();
});

await check("a whole-run sweep finds no sentinel anywhere", () => {
  const logs = captured.join("\n");

  for (const sentinel of ALL_SENTINELS) {
    assert.ok(!logs.includes(sentinel), `${sentinel} reached the logs`);
  }
});

console.log = realLog;
console.error = realError;

realLog("");
realLog(`${passed} checks passed`);
realLog("no real API key, prompt, or system prompt read, printed, or persisted");
