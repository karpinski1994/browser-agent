import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Write a file such that readers never observe a partially written one.
 *
 * The contents are written to a sibling temporary file first and then
 * renamed over the destination. On POSIX, `rename(2)` within the same
 * directory is atomic, so an interrupted write leaves either the old
 * file or the new one — never a truncated mix of the two.
 *
 * The temporary file must live in the destination directory (not in the
 * system temp dir) because `rename` fails with EXDEV across
 * filesystems, and `userData` may well be on a different mount than
 * /tmp.
 */
export function writeFileAtomic(
  filePath: string,
  contents: string,
  mode?: number,
): void {
  const directory = dirname(filePath);

  mkdirSync(directory, { recursive: true });

  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    writeFileSync(temporaryPath, contents, {
      encoding: "utf8",
      ...(mode === undefined ? {} : { mode }),
    });

    renameSync(temporaryPath, filePath);
  } catch (error) {
    // Best-effort cleanup: a leaked .tmp is untidy but harmless, and it
    // must not mask the original failure.
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Intentionally ignored.
    }

    throw error;
  }
}
