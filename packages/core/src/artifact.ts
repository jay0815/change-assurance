import { randomUUID } from "node:crypto";

export const RUNS_DIR = ".change-assurance/runs";

export function generateRunId(): string {
  return randomUUID();
}

export function getRunDir(runId: string): string {
  return `${RUNS_DIR}/${runId}`;
}

export function getInputDir(runId: string): string {
  return `${getRunDir(runId)}/input`;
}

export function getInputArtifactPath(runId: string, filename: string): string {
  return `${getInputDir(runId)}/${filename}`;
}

export function getVerificationDir(runId: string): string {
  return `${getRunDir(runId)}/verification`;
}

export function getVerificationLedgerPath(runId: string): string {
  return `${getVerificationDir(runId)}/verification-ledger.json`;
}

export function getVerificationLogPath(runId: string, commandId: string, stream: "stdout" | "stderr"): string {
  return `${getVerificationDir(runId)}/logs/${commandId}.${stream}.log`;
}

export const INPUT_ARTIFACTS = {
  INPUT_MANIFEST: "input-manifest.json",
  DIFF_PATCH: "diff.patch",
  CHANGED_FILES: "changed-files.json",
  GIT_STATE: "git-state.json",
  POLICY_SNAPSHOT: "policy.snapshot.yaml",
} as const;

export const VERIFICATION_ARTIFACTS = {
  LEDGER: "verification-ledger.json",
  LOGS_DIR: "logs",
} as const;

export function getStagesDir(runId: string): string {
  return `${getRunDir(runId)}/stages`;
}

export function getStageArtifactPath(runId: string, stage: string): string {
  return `${getStagesDir(runId)}/${stage}.json`;
}

export function getStageRawArtifactPath(runId: string, stage: string): string {
  return `${getStagesDir(runId)}/${stage}.raw.json`;
}

export function getLedgersDir(runId: string): string {
  return `${getRunDir(runId)}/ledgers`;
}

export function getIssueLedgerPath(runId: string): string {
  return `${getLedgersDir(runId)}/issue-ledger.json`;
}

export function getCoverageLedgerPath(runId: string): string {
  return `${getLedgersDir(runId)}/coverage-ledger.json`;
}
