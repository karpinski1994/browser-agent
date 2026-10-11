import { app, BrowserWindow, ipcMain, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAppPaths } from "./appPaths";
import { AgentRuntimeService } from "./agentRuntimeService";
import { SettingsController } from "./settingsIpc";
import { createSafeStorageEncryptor } from "./secureStorage";
import { SettingsService } from "./settingsService";

import type { AgentEvent } from "../shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

const agent = new AgentRuntimeService();

function broadcast(event: AgentEvent) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("agent-event", event);
    }
  }
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;

  const width = 420;
  const height = 260;
  const margin = 20;

  mainWindow = new BrowserWindow({
    width,
    height,

    x: workArea.x + workArea.width - width - margin,
    y: workArea.y + workArea.height - height - margin,

    alwaysOnTop: true,
    frame: false,
    transparent: true,
    resizable: true,

    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    console.log(
      "[WINDOW] Loading renderer:",
      process.env.ELECTRON_RENDERER_URL,
    );

    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    const rendererPath = path.join(
      __dirname,
      "../renderer/index.html",
    );

    console.log("[WINDOW] Loading renderer:", rendererPath);

    mainWindow.loadFile(rendererPath);
  }

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("[WINDOW] Renderer loaded");
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription) => {
      console.error(
        "[WINDOW] Renderer failed:",
        errorCode,
        errorDescription,
      );
    },
  );
}

app.whenReady().then(() => {
  console.log("[APP] Ready");

  agent.subscribe(broadcast);

  const settingsController = createSettingsController();

  ipcMain.handle(
    "agent:send",
    async (_event, message: string) => {
      /*
       * The payload is never logged: it is the user's prompt, and the
       * main process has no reason to retain or echo it. A rejection
       * from agent.send() already carries a safe message, so nothing
       * here needs wrapping.
       */
      console.log("[IPC] agent:send");

      agent.send(message);
    },
  );

  ipcMain.handle(
    "agent:steer",
    async (_event, message: string) => {
      console.log("[IPC] agent:steer");

      agent.steer(message);
    },
  );

  ipcMain.handle(
    "agent:get-status",
    () => {
      return agent.getStatus();
    },
  );

  /*
   * The operation the renderer actually uses. getStatus() stays
   * available above rather than being repurposed, so the two contracts
   * cannot drift into each other.
   */
  ipcMain.handle(
    "agent:get-snapshot",
    () => {
      return agent.getSnapshot();
    },
  );

  ipcMain.handle("settings:get", () => {
    return settingsController.getSnapshot();
  });

  /*
   * The payload is never logged: it carries the API key.
   */
  ipcMain.handle("settings:save", (_event, payload: unknown) => {
    console.log("[IPC] settings:save");

    const result = settingsController.save(payload);

    console.log("[IPC] settings:save result", result.ok ? "ok" : result.error.code);

    return result;
  });

  createWindow();

  startAgent(settingsController);
});

/*
 * Owns settings persistence, Pi config generation and runtime startup
 * as one unit, so a save and a launch cannot drift apart.
 */
function createSettingsController(): SettingsController {
  const paths = getAppPaths();

  return new SettingsController({
    settings: new SettingsService(
      paths.settingsPaths,
      createSafeStorageEncryptor(),
    ),
    piAgentDir: paths.piAgentDir,
    cwd: process.cwd(),
    /*
     * restart() is safe on first launch: stop() is a no-op when nothing
     * is running, and start() refuses to overlap an existing process.
     */
    startRuntime: (config) => agent.restart(config),
  });
}

/*
 * Boot the agent from whatever is stored.
 *
 * With no usable settings nothing is spawned and the failure code
 * becomes the existing "error" status, which the renderer turns into
 * the setup screen. There is no fallback to Kilo or to any default
 * model.
 *
 * The attempt reports a stable code rather than prose, so the summary
 * the user eventually sees is produced in exactly one place and no
 * exception text can travel this far.
 */
function startAgent(controller: SettingsController) {
  const attempt = controller.startFromStoredSettings();

  if (!attempt.ok) {
    agent.failStartup(attempt.failure);

    return;
  }

  console.log("[APP] Agent runtime started from stored settings");
}

app.on("window-all-closed", () => {
  agent.stop();

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  agent.stop();
});
