import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  generateRunId,
  getInputDir,
  INPUT_ARTIFACTS,
  isGitRepository,
  refExists,
  collectGitState,
  getDiff,
  getChangedFiles,
} from "@change-assurance/core";
import { loadPolicy } from "./policy.js";

export interface PrepareOptions {
  base: string;
  head: string;
}

export class PrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrepareError";
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function reviewPrepare(options: PrepareOptions): {
  runId: string;
  inputDir: string;
} {
  const cwd = process.cwd();

  if (!isGitRepository()) {
    throw new PrepareError("Not a git repository");
  }

  if (!refExists(options.base)) {
    throw new PrepareError(`Base ref not found: ${options.base}`);
  }

  if (!refExists(options.head)) {
    throw new PrepareError(`Head ref not found: ${options.head}`);
  }

  const runId = generateRunId();
  const inputDir = resolve(cwd, getInputDir(runId));
  mkdirSync(inputDir, { recursive: true });

  const policy = loadPolicy(cwd);
  const policySnapshot = JSON.stringify(policy, null, 2);
  const diff = getDiff(options.base, options.head);
  const changedFiles = getChangedFiles(options.base, options.head);
  const gitState = collectGitState(options.base, options.head);

  const inputManifest = {
    runId,
    baseRef: options.base,
    headRef: options.head,
    createdAt: new Date().toISOString(),
    policySnapshotHash: sha256(policySnapshot),
    diffHash: sha256(diff),
    changedFilesHash: sha256(JSON.stringify(changedFiles)),
    gitStateHash: sha256(JSON.stringify(gitState)),
  };

  writeFileSync(
    resolve(inputDir, INPUT_ARTIFACTS.INPUT_MANIFEST),
    JSON.stringify(inputManifest, null, 2),
  );
  writeFileSync(resolve(inputDir, INPUT_ARTIFACTS.DIFF_PATCH), diff);
  writeFileSync(
    resolve(inputDir, INPUT_ARTIFACTS.CHANGED_FILES),
    JSON.stringify(changedFiles, null, 2),
  );
  writeFileSync(
    resolve(inputDir, INPUT_ARTIFACTS.GIT_STATE),
    JSON.stringify(gitState, null, 2),
  );
  writeFileSync(
    resolve(inputDir, INPUT_ARTIFACTS.POLICY_SNAPSHOT),
    policySnapshot,
  );

  return { runId, inputDir };
}
