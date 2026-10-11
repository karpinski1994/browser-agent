import { contextBridge, ipcRenderer } from "electron";

import type {
  AgentBridge,
  AgentEvent,
  AgentRuntimeSnapshot,
  AgentStatus,
  SaveSettingsInput,
  SettingsSaveResult,
  SettingsSnapshot,
} from "../shared/types";

/*
 * Annotating `api` with AgentBridge makes the compiler verify that what
 * we hand to contextBridge actually matches what the renderer expects.
 *
 * This is the renderer's entire capability surface: agent methods,
 * settings methods and one event subscription. Electron, Node and the
 * filesystem stay unreachable from the renderer, and there is no
 * generic invoke() passthrough to abuse.
 *
 * ipcRenderer.invoke is typed as Promise<any> by Electron, so the
 * result casts below assert the payload shape the main process sends.
 * They are casts, not runtime validation — the main process is the
 * authority and re-checks everything it receives.
 */
const api: AgentBridge = {
  agent: {
    send: (message: string) =>
      ipcRenderer.invoke("agent:send", message) as Promise<void>,

    steer: (message: string) =>
      ipcRenderer.invoke("agent:steer", message) as Promise<void>,

    /*
     * Two read operations rather than one changed contract: getStatus()
     * keeps its original string return so nothing that already depends
     * on it breaks, and getSnapshot() is the new, richer one.
     */
    getStatus: () =>
      ipcRenderer.invoke("agent:get-status") as Promise<AgentStatus>,

    getSnapshot: () =>
      ipcRenderer.invoke("agent:get-snapshot") as Promise<AgentRuntimeSnapshot>,
  },

  settings: {
    get: () =>
      ipcRenderer.invoke("settings:get") as Promise<SettingsSnapshot>,

    save: (input: SaveSettingsInput) =>
      ipcRenderer.invoke("settings:save", input) as Promise<SettingsSaveResult>,
  },

  events: {
    on: (listener) => {
      const handler = (
        _event: unknown,
        payload: AgentEvent,
      ) => {
        listener(payload);
      };

      ipcRenderer.on("agent-event", handler);

      return () => {
        ipcRenderer.off("agent-event", handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld("agent", api);
