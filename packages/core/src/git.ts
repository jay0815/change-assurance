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
  return git(["diff", `${base}...${head}`]);
}

export function getChangedFiles(base: string, head: string): ChangedFile[] {
  const raw = git(["diff", "--numstat", `${base}...${head}`]);
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
