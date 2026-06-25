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

export const INPUT_ARTIFACTS = {
  INPUT_MANIFEST: "input-manifest.json",
  DIFF_PATCH: "diff.patch",
  CHANGED_FILES: "changed-files.json",
  GIT_STATE: "git-state.json",
  POLICY_SNAPSHOT: "policy.snapshot.yaml",
} as const;
