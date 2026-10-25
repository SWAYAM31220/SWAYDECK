import * as fs from "fs";
import * as path from "path";
import {
  DetectionResult,
  DetectedSignal,
  ProjectType,
  WorkspaceDetails,
} from "./types";

/**
 * Projects beyond this size are never parsed; the file is treated as if it has
 * no usable scripts.
 */
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

/**
 * Returns true only when `target` exists and is a regular file.
 * Missing, unreadable, or directory entries return false instead of throwing.
 */
function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Read-only check for a `dev` script in package.json.
 *
 * The file is only read to determine whether `scripts.dev` exists as a string.
 * Script command strings are never returned or reported. Invalid JSON, oversized
 * files, and read errors are swallowed and reported as "no dev script".
 */
function hasDevScript(packageJsonPath: string): boolean {
  try {
    const stat = fs.statSync(packageJsonPath);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_JSON_BYTES) {
      return false;
    }
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return false;
    }
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null) {
      return false;
    }
    return typeof (scripts as { dev?: unknown }).dev === "string";
  } catch {
    return false;
  }
}

const EMPTY_DETAILS: WorkspaceDetails = {
  hasPackageJson: false,
  hasDevScript: false,
  hasMainPy: false,
  hasIndexHtml: false,
};

/**
 * Detects the project type of a single workspace root by looking only at
 * {package.json, main.py, index.html} in that root.
 *
 * Pure with respect to the filesystem: same filesystem state in, same result out.
 * Never throws.
 */
export function detectProject(rootPath: string | null): DetectionResult {
  if (!rootPath) {
    return { projectType: "none", detected: [], details: { ...EMPTY_DETAILS } };
  }

  const packageJsonPath = path.join(rootPath, "package.json");
  const mainPyPath = path.join(rootPath, "main.py");
  const indexHtmlPath = path.join(rootPath, "index.html");

  const details: WorkspaceDetails = {
    hasPackageJson: isFile(packageJsonPath),
    hasDevScript: false,
    hasMainPy: isFile(mainPyPath),
    hasIndexHtml: isFile(indexHtmlPath),
  };

  if (details.hasPackageJson) {
    details.hasDevScript = hasDevScript(packageJsonPath);
  }

  const detected: DetectedSignal[] = [];
  if (details.hasPackageJson) {
    detected.push({ type: "node", evidence: "package.json" });
  }
  if (details.hasMainPy) {
    detected.push({ type: "python", evidence: "main.py" });
  }
  // "static" only counts when package.json is absent.
  if (details.hasIndexHtml && !details.hasPackageJson) {
    detected.push({ type: "static", evidence: "index.html" });
  }

  let projectType: ProjectType;
  if (detected.length === 0) {
    projectType = "unknown";
  } else if (detected.length === 1) {
    projectType = detected[0].type as ProjectType;
  } else {
    projectType = "ambiguous";
  }

  return { projectType, detected, details };
}
