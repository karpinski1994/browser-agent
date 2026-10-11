import { createRequire } from "node:module";

import type { Encryptor } from "./settingsService";

/**
 * safeStorage-backed encryption for the API key at rest.
 *
 * Electron's safeStorage uses the OS keychain (Keychain on macOS,
 * DPAPI on Windows, kwallet/gnome-libsecret on Linux) via Chromium's
 * os_crypt. The ciphertext is only decryptable by the same user on the
 * same machine, which is the strongest at-rest protection available
 * without asking the user for a passphrase.
 *
 * Electron is required lazily: importing it at module scope from a
 * non-Electron process resolves to the npm shim, which exports a path
 * string rather than the API surface, and fails at link time.
 */
export function createSafeStorageEncryptor(): Encryptor {
  const require = createRequire(import.meta.url);

  const { safeStorage } = require("electron") as typeof import("electron");

  return {
    get available(): boolean {
      return safeStorage.isEncryptionAvailable();
    },

    encrypt(plaintext: string): Buffer {
      return safeStorage.encryptString(plaintext);
    },

    decrypt(ciphertext: Buffer): string {
      return safeStorage.decryptString(ciphertext);
    },
  };
}
