import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import {
  getInputDir,
  getVerificationDir,
  getVerificationLedgerPath,
  getVerificationLogPath,
  INPUT_ARTIFACTS,
  getHeadCommit,
  isWorkingTreeDirty,
  minimatch,
} from "@change-assurance/core";
import type {
  InputManifest,
  ChangedFile,
  GitState,
  PolicyConfig,
  VerificationCommandPolicy,
  VerificationLedger,
  VerificationCommandResult,
  VerificationStatus,
} from "@change-assurance/core";

export interface VerifyOptions {
  runId: string;
}

export class VerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyError";
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readJsonFile<T>(path: string): T {
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content) as T;
}

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(filePath, pattern));
}

function shouldExecuteCommand(
  command: VerificationCommandPolicy,
  changedFiles: ChangedFile[],
): { required: boolean; reason: string } {
  if (!command.when?.pathsAny) {
    return { required: true, reason: "no when condition specified" };
  }

  const matched = changedFiles.some((f) => matchesAnyPattern(f.path, command.when!.pathsAny!));

  if (matched) {
    return {
      required: true,
      reason: `pathsAny matched: ${command.when.pathsAny.join(", ")}`,
    };
  }

  return {
    required: false,
    reason: `no changed files match pathsAny: ${command.when.pathsAny.join(", ")}`,
  };
}

function executeCommand(
  argv: string[],
  cwd: string,
): { exitCode: number; stdout: string; stderr: string } {
  const [cmd, ...args] = argv;
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function reviewVerify(options: VerifyOptions): VerificationLedger {
  const cwd = process.cwd();
  const runId = options.runId;
  const inputDir = resolve(cwd, getInputDir(runId));

  if (!existsSync(inputDir)) {
    throw new VerifyError(`Run not found: ${runId}`);
  }

  // Read input artifacts
  const manifestPath = resolve(inputDir, INPUT_ARTIFACTS.INPUT_MANIFEST);
  const manifest = readJsonFile<InputManifest>(manifestPath);

  const policySnapshotPath = resolve(inputDir, INPUT_ARTIFACTS.POLICY_SNAPSHOT);
  const policySnapshotContent = readFileSync(policySnapshotPath, "utf-8");
  const policy = parse(policySnapshotContent) as PolicyConfig;

  const changedFilesPath = resolve(inputDir, INPUT_ARTIFACTS.CHANGED_FILES);
  const changedFilesContent = readFileSync(changedFilesPath, "utf-8");
  const changedFiles = JSON.parse(changedFilesContent) as ChangedFile[];

  const gitStatePath = resolve(inputDir, INPUT_ARTIFACTS.GIT_STATE);
  const gitStateContent = readFileSync(gitStatePath, "utf-8");
  const gitState = JSON.parse(gitStateContent) as GitState;

  const diffPath = resolve(inputDir, INPUT_ARTIFACTS.DIFF_PATCH);
  const diffContent = readFileSync(diffPath, "utf-8");

  // Validate preconditions
  const preconditionErrors: string[] = [];

  if (sha256(policySnapshotContent) !== manifest.policySnapshotHash) {
    preconditionErrors.push("policy.snapshot.yaml hash mismatch with input-manifest.json");
  }

  if (sha256(changedFilesContent) !== manifest.changedFilesHash) {
    preconditionErrors.push("changed-files.json hash mismatch with input-manifest.json");
  }

  if (sha256(gitStateContent) !== manifest.gitStateHash) {
    preconditionErrors.push("git-state.json hash mismatch with input-manifest.json");
  }

  if (sha256(diffContent) !== manifest.diffHash) {
    preconditionErrors.push("diff.patch hash mismatch with input-manifest.json");
  }

  const currentHead = getHeadCommit();
  if (currentHead !== gitState.headCommit) {
    preconditionErrors.push(`HEAD changed: expected ${gitState.headCommit}, got ${currentHead}`);
  }

  if (isWorkingTreeDirty()) {
    preconditionErrors.push("Git working tree is dirty");
  }

  // Create blocked ledger if preconditions failed
  if (preconditionErrors.length > 0) {
    const ledger: VerificationLedger = {
      runId,
      createdAt: new Date().toISOString(),
      runStatus: "blocked",
      policySnapshotHash: manifest.policySnapshotHash,
      preconditionErrors,
      commands: [],
      summary: { passed: 0, failed: 0, skipped: 0, notRequired: 0 },
      workspaceChangedAfterVerify: false,
    };

    const verificationDir = resolve(cwd, getVerificationDir(runId));
    mkdirSync(verificationDir, { recursive: true });
    mkdirSync(resolve(verificationDir, "logs"), { recursive: true });
    writeFileSync(resolve(cwd, getVerificationLedgerPath(runId)), JSON.stringify(ledger, null, 2));

    return ledger;
  }

  // Execute verification commands
  const commands = policy.verification?.commands ?? [];
  const verificationDir = resolve(cwd, getVerificationDir(runId));
  mkdirSync(verificationDir, { recursive: true });
  mkdirSync(resolve(verificationDir, "logs"), { recursive: true });

  const commandResults: VerificationCommandResult[] = [];

  for (const cmd of commands) {
    const { required, reason } = shouldExecuteCommand(cmd, changedFiles);

    if (!required) {
      commandResults.push({
        id: cmd.id,
        argv: cmd.argv,
        required: false,
        status: "not_required",
        selectionReason: reason,
      });
      continue;
    }

    // Execute command
    const startedAt = new Date().toISOString();
    const { exitCode, stdout, stderr } = executeCommand(cmd.argv, cwd);
    const endedAt = new Date().toISOString();
    const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();

    // Save logs
    const stdoutPath = getVerificationLogPath(runId, cmd.id, "stdout");
    const stderrPath = getVerificationLogPath(runId, cmd.id, "stderr");
    writeFileSync(resolve(cwd, stdoutPath), stdout);
    writeFileSync(resolve(cwd, stderrPath), stderr);

    const status: VerificationStatus = exitCode === 0 ? "passed" : "failed";

    commandResults.push({
      id: cmd.id,
      argv: cmd.argv,
      required: true,
      status,
      selectionReason: reason,
      startedAt,
      endedAt,
      durationMs,
      exitCode,
      stdoutPath,
      stderrPath,
    });
  }

  // Check if workspace changed after verify
  const workspaceChangedAfterVerify = isWorkingTreeDirty();

  // Calculate summary
  const summary = {
    passed: commandResults.filter((c) => c.status === "passed").length,
    failed: commandResults.filter((c) => c.status === "failed").length,
    skipped: commandResults.filter((c) => c.status === "skipped").length,
    notRequired: commandResults.filter((c) => c.status === "not_required").length,
  };

  const ledger: VerificationLedger = {
    runId,
    createdAt: new Date().toISOString(),
    runStatus: workspaceChangedAfterVerify ? "invalidated" : "completed",
    policySnapshotHash: manifest.policySnapshotHash,
    preconditionErrors: [],
    commands: commandResults,
    summary,
    workspaceChangedAfterVerify,
  };

  writeFileSync(resolve(cwd, getVerificationLedgerPath(runId)), JSON.stringify(ledger, null, 2));

  return ledger;
}
