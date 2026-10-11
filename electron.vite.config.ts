import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

/**
 * Canonical browser-agent instructions.
 *
 * Tracked in the repository at .pi/APPEND_SYSTEM.md, which is also what
 * the Pi CLI reads for this repository when run interactively.
 */
const APPEND_SYSTEM_SOURCE = resolve(__dirname, ".pi/APPEND_SYSTEM.md");

/**
 * Emit the browser-agent instructions next to the main-process entry.
 *
 * out/main/APPEND_SYSTEM.md is the copy src/main/promptAsset.ts looks
 * for first, so this is what a running or packaged app reads. out/ is
 * gitignored: the emitted file is build output, not a second editable
 * copy, and the repository file above stays the single source of truth.
 *
 * Attached to the main build only — the preload and renderer never read
 * it. Watching the source in buildStart matters for development:
 * electron-vite rebuilds the main process through a Rollup watcher, so
 * an edit to the instructions re-emits the asset automatically.
 */
const appendSystemAsset = () => ({
  name: "append-system-asset",

  buildStart(this: { addWatchFile: (id: string) => void }) {
    this.addWatchFile(APPEND_SYSTEM_SOURCE);
  },

  generateBundle(
    this: {
      emitFile: (file: {
        type: "asset";
        fileName: string;
        source: string;
      }) => void;
    },
  ) {
    this.emitFile({
      type: "asset",
      fileName: "APPEND_SYSTEM.md",
      source: readFileSync(APPEND_SYSTEM_SOURCE, "utf8"),
    });
  },
});

export default defineConfig({
  main: {
    plugins: [appendSystemAsset()],

    build: {
      outDir: "out/main",
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts"),
      },
    },
  },

  preload: {
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },

  renderer: {
    root: resolve(__dirname, "src/renderer"),

    server: {
      port: 5373,
      strictPort: true,
    },

    build: {
      outDir: "out/renderer",

      rollupOptions: {
        input: resolve(
          __dirname,
          "src/renderer/index.html",
        ),
      },
    },
  },
});
