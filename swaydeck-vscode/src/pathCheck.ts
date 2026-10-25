import * as fs from "fs";
import * as path from "path";

/**
 * Looks for the first of `names` that exists in a directory listed on PATH.
 *
 * Filesystem lookups only: nothing is spawned or executed, and this function
 * never throws. Returns the full path, or null when nothing was found.
 */
export function findOnPath(names: string[]): string | null {
  let pathValue: string;
  try {
    pathValue = process.env.PATH ?? "";
  } catch {
    return null;
  }

  let dirs: string[];
  try {
    dirs = pathValue.split(path.delimiter);
  } catch {
    return null;
  }

  for (const dir of dirs) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      try {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // Ignore unreadable or invalid PATH entries.
      }
    }
  }

  return null;
}
