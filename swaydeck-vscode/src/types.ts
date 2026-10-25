/**
 * Shared types for the SwayDeck Bridge extension.
 *
 * These types describe the payload that is reported to the local SwayDeck PC
 * agent. Nothing here contains file contents, full paths of open files, or
 * environment variables.
 */

export type ProjectType =
  | "node"
  | "python"
  | "static"
  | "ambiguous"
  | "unknown"
  | "none";

export interface DetectedSignal {
  type: string;
  evidence: string;
}

export interface WorkspaceFolderInfo {
  name: string;
  path: string;
}

export interface WorkspaceDetails {
  hasPackageJson: boolean;
  hasDevScript: boolean;
  hasMainPy: boolean;
  hasIndexHtml: boolean;
}

export interface WorkspacePayload {
  open: boolean;
  name: string | null;
  path: string | null;
  multiRoot: boolean;
  folders: WorkspaceFolderInfo[];
  trusted: boolean;
  projectType: ProjectType;
  detected: DetectedSignal[];
  details: WorkspaceDetails;
  /** Basename of the active file only, never a full path. */
  activeFile: string | null;
}

/**
 * Result of the pure filesystem-based project detection for a single root.
 */
export interface DetectionResult {
  projectType: ProjectType;
  detected: DetectedSignal[];
  details: WorkspaceDetails;
}

export type RunStatus = "started" | "already_running" | "ambiguous" | "error";

/**
 * Outcome of a "run project" request. Reported to the agent as the body of a
 * `run_result` message and shown locally by the `SwayDeck: Run Project` command.
 */
export interface RunResult {
  ok: boolean;
  status: RunStatus;
  /** Human readable, at most 200 characters. */
  message: string;
  projectType: ProjectType;
  /** Detected project types; only filled for status "ambiguous", at most 5. */
  options: string[];
  /**
   * Address of the started server for `static` projects (for example
   * "http://localhost:5500"). Always null for node and python results.
   */
  url: string | null;
}
