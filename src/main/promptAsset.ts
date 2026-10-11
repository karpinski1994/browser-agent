import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Name of the browser-agent instruction file.
 *
 * Same name in all three places it exists: the canonical repository
 * source, the build-emitted copy next to the main-process entry point,
 * and the generated file inside the app-owned Pi configuration
 * directory. Pi looks for exactly this name (see APPEND_SYSTEM.md in
 * the installed package's resource loader).
 */
export const APPEND_SYSTEM_FILE_NAME = "APPEND_SYSTEM.md";

/**
 * Directory this module itself lives in.
 *
 * Derived from import.meta.url rather than a bare `__dirname`: __dirname
 * is not an ES-module global, and the local `__dirname` const declared
 * in index.ts is scoped to that module, so it is not visible here.
 *
 * In the bundled main-process output this resolves to out/main; when the
 * source is executed directly (the verification scripts under tsx) it
 * resolves to src/main.
 */
const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Where the canonical instructions may be read from, most authoritative
 * first.
 *
 *   1. The build-emitted copy, next to the entry point. electron.vite
 *      config.ts emits the instructions into out/main on every build and
 *      every dev rebuild, so this is the copy a running or packaged app
 *      has. It is build output (out/ is gitignored): never hand-edited,
 *      never kept in sync manually.
 *
 *   2. The canonical repository source, <base>/../../.pi/. Used only
 *      when no emitted copy exists, which is the case when code runs
 *      straight out of src/ — the verification scripts.
 *
 * Deliberately neither process.cwd() nor an assumed repository root:
 * neither exists inside a packaged app, and neither is needed for this
 * to resolve. When both are absent the resolution simply fails and the
 * caller reports it, rather than silently producing an app with no
 * browser-agent instructions.
 */
export function appendSystemPromptCandidates(baseDir: string): string[] {
  return [
    join(baseDir, APPEND_SYSTEM_FILE_NAME),
    join(baseDir, "..", "..", ".pi", APPEND_SYSTEM_FILE_NAME),
  ];
}

/**
 * Read the canonical browser-agent instructions, verbatim.
 *
 * Re-read on every call and never cached, so regenerating the Pi config
 * always picks up the current instructions.
 *
 * Throws rather than returning anything else when neither candidate
 * exists. A silent empty result would be worse than a failure here:
 * Pi's `--append-system-prompt` treats a non-existent path as literal
 * text, so a missing file would append the path string itself into the
 * system prompt instead of the instructions.
 *
 * The error message deliberately carries no filesystem paths. It is a
 * third-party-visible error and this codebase keeps machine-specific
 * paths out of messages; the caller in settingsIpc discards the
 * exception entirely and reports a stable config_write_failed code.
 */
export function readAppendSystemPrompt(baseDir: string = moduleDir): string {
  for (const candidate of appendSystemPromptCandidates(baseDir)) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, "utf8");
    }
  }

  throw new Error("browser-agent prompt asset is missing");
}
