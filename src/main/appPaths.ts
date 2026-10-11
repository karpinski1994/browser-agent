import { app } from "electron";

import { piConfigDirForUserData } from "./configGenerator";
import {
  SettingsService,
  type SettingsPaths,
} from "./settingsService";

/**
 * Every application-owned path the agent runtime needs, derived from a
 * single Electron-owned root.
 *
 * Keeping this in its own module confines the Electron dependency to
 * the main process and keeps the rest of the pipeline (config
 * generation, settings, spawn construction) free of Electron so it can
 * be exercised directly in verification scripts.
 */
export type AppPaths = {
  /** Electron's userData dir, e.g. ~/Library/Application Support/<app>. */
  userDataDir: string;

  /** settings.json and the separately-stored encrypted API key. */
  settingsPaths: SettingsPaths;

  /** Directory handed to Pi as PI_CODING_AGENT_DIR. */
  piAgentDir: string;
};

/**
 * Resolve the app-owned paths.
 *
 * Must be called after app.whenReady(): userData is the canonical
 * per-user, per-app location Electron owns and clears/creates on the
 * app's behalf.
 */
export function getAppPaths(): AppPaths {
  const userDataDir = app.getPath("userData");

  return {
    userDataDir,
    settingsPaths: SettingsService.pathsForUserData(userDataDir),
    piAgentDir: piConfigDirForUserData(userDataDir),
  };
}
