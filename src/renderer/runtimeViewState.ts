/*
 * Pure, DOM-free runtime state for the renderer.
 *
 * Why this exists: the main process owns the runtime and emits status
 * transitions immediately, including before this renderer has finished
 * loading. The renderer therefore subscribes first and then *pulls* a
 * snapshot — but the pull resolves asynchronously, so it can land after
 * an event that is already newer than it. Without a revision, the late
 * pull would silently rewind the status line and, worse, erase the
 * error message the user was just shown.
 *
 * Keeping the rule in a pure module (rather than inside an event
 * handler) makes both orderings testable without a DOM.
 */
import type {
  AgentRuntimeSnapshot,
  AgentStatus,
} from "../shared/types";

export type RuntimeViewState = {
  /** Highest revision applied so far. */
  appliedRevision: number;

  status: AgentStatus;
  error: string | null;
  detail: string | null;
};

/**
 * Revision -1, not 0: the main process's initial stopped snapshot is
 * revision 0 and must be accepted on a cold start.
 */
export const INITIAL_RUNTIME_VIEW_STATE: RuntimeViewState = {
  appliedRevision: -1,
  status: "stopped",
  error: null,
  detail: null,
};

/**
 * Apply a snapshot, ignoring it when it is older than one already seen.
 *
 * Pushed events and pulled snapshots both go through here, so a stale
 * pull that resolves late cannot overwrite a newer pushed event, and an
 * event that arrives before the pull cannot be clobbered by it either.
 *
 * Snapshots carrying the same revision are applied: a duplicate is
 * harmless, and rejecting it would make a retry after a dropped event
 * impossible to repair.
 */
export function applyRuntimeSnapshot(
  state: RuntimeViewState,
  snapshot: AgentRuntimeSnapshot,
): RuntimeViewState {
  if (snapshot.revision < state.appliedRevision) {
    return state;
  }

  // Main owns these invariants; a defensive copy here means a malformed
  // payload cannot put the renderer into an unmappable state.
  const status: AgentStatus = snapshot.status;
  const isError = status === "error";

  return {
    appliedRevision: snapshot.revision,
    status,
    error: isError ? snapshot.error : null,
    detail: isError ? snapshot.detail : null,
  };
}
