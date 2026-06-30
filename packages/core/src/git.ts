import { execFileSync } from "node:child_process";
import type { ChangedFile, GitState } from "./types.js";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf-8" }).trim();
  } catch (error) {
    throw new GitError(`git ${args.join(" ")} failed: ${error}`);
  }
}

export function isGitRepository(): boolean {
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

export function refExists(ref: string): boolean {
  try {
    git(["rev-parse", "--verify", ref]);
    return true;
  } catch {
    return false;
  }
}

export function getHeadCommit(): string {
  return git(["rev-parse", "HEAD"]);
}

export function getCurrentBranch(): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function isWorkingTreeDirty(): boolean {
  const status = git(["status", "--porcelain"]);
  return status.length > 0;
}

export function getDiff(base: string, head: string): string {
  // Check if base exists
  try {
    git(["rev-parse", base]);
    return git(["diff", `${base}...${head}`]);
  } catch {
    // Base doesn't exist (e.g., HEAD~1 on initial commit), show all changes from empty tree
    return git(["diff", "4b825dc642cb6eb9a060e54bf899d15363d4aa98", head]);
  }
}

export function getChangedFiles(base: string, head: string): ChangedFile[] {
  // Check if base exists
  let raw: string;
  try {
    git(["rev-parse", base]);
    raw = git(["diff", "--numstat", `${base}...${head}`]);
  } catch {
    // Base doesn't exist, show all changes from empty tree
    raw = git(["diff", "--numstat", "4b825dc642cb6eb9a060e54bf899d15363d4aa98", head]);
  }

  if (!raw) return [];

  return raw.split("\n").map((line) => {
    const [additions, deletions, path] = line.split("\t");
    return {
      path,
      status: "modified" as const,
      additions: parseInt(additions, 10) || 0,
      deletions: parseInt(deletions, 10) || 0,
    };
  });
}

export function getBaseCommit(base: string): string {
  return git(["rev-parse", base]);
}

export function getFileContentAtCommit(commit: string, path: string): string {
  return git(["show", `${commit}:${path}`]);
}

export function fileExistsAtCommit(commit: string, path: string): boolean {
  try {
    git(["cat-file", "-e", `${commit}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

export function collectGitState(base: string, head: string): GitState {
  return {
    baseRef: base,
    headRef: head,
    baseCommit: getBaseCommit(base),
    headCommit: getHeadCommit(),
    branch: getCurrentBranch(),
    isDirty: isWorkingTreeDirty(),
    timestamp: new Date().toISOString(),
  };
}
