import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import {
  getInputDir,
  getStagesDir,
  getStageArtifactPath,
  getStageRawArtifactPath,
  getVerificationLedgerPath,
  INPUT_ARTIFACTS,
  VERIFICATION_ARTIFACTS,
  getHeadCommit,
  isWorkingTreeDirty,
} from "@change-assurance/core";
import type {
  InputManifest,
  ChangeMap,
  ReviewStage,
} from "@change-assurance/core";

export interface AdapterCapabilities {
  available: boolean;
  version?: string;
  supportsJsonOutput: boolean;
  supportsJsonSchema: boolean;
}

export interface RunStageInput {
  stage: string;
  runDirectory: string;
  prompt: string;
  schema: object;
}

export interface RunStageOutput {
  rawOutput: unknown;
  structuredOutput: unknown;
}

export interface ReviewStageAdapter {
  detectCapabilities(): AdapterCapabilities;
  runStage(input: RunStageInput): Promise<RunStageOutput>;
}

export interface StageOptions {
  runId: string;
  stage: ReviewStage;
  adapter: ReviewStageAdapter;
}

export class StageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageError";
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateChangeMap(output: any): string[] {
  const errors: string[] = [];

  const forbiddenFields = ["blocker", "issue", "severity", "blocking", "approve", "mergeRecommendation"];
  for (const field of forbiddenFields) {
    if (field in output) {
      errors.push(`Forbidden field: ${field}`);
    }
  }

  return errors;
}

function validateEvidenceRefs(output: ChangeMap, runDir: string): string[] {
  const errors: string[] = [];

  if (!output.behaviorChanges || !output.riskAreas) {
    return errors;
  }

  const allRefs = [
    ...(output.behaviorChanges ?? []).flatMap((b) => b.evidenceRefs ?? []),
    ...(output.riskAreas ?? []).flatMap((r) => r.evidenceRefs ?? []),
  ];

  for (const ref of allRefs) {
    const refPath = resolve(runDir, ref);
    if (!existsSync(refPath)) {
      errors.push(`Evidence ref not found: ${ref}`);
    }
  }

  return errors;
}

function validateAdequacy(output: ChangeMap, changedFiles: Array<{ path: string }>, manifest: InputManifest): string[] {
  const errors: string[] = [];

  // Rule 1: changedModules must not be empty when there are changes
  if (changedFiles.length > 0 && (!output.changedModules || output.changedModules.length === 0)) {
    errors.push("changedModules must not be empty when diff has changes");
  }

  // Rule 1: each changedModule path must be in changedFiles
  const changedPaths = new Set(changedFiles.map((f) => f.path));
  for (const mod of output.changedModules ?? []) {
    if (!changedPaths.has(mod.path)) {
      errors.push(`changedModule path not in changed files: ${mod.path}`);
    }
    if (!mod.role || mod.role.trim() === "") {
      errors.push(`changedModule has empty role: ${mod.path}`);
    }
    if (!mod.changeSummary || mod.changeSummary.trim() === "") {
      errors.push(`changedModule has empty changeSummary: ${mod.path}`);
    }
  }

  // Rule 2: if all analysis arrays are empty, must have explanation
  const allAnalysisEmpty =
    (output.behaviorChanges ?? []).length === 0 &&
    (output.riskAreas ?? []).length === 0 &&
    (output.reviewPriorities ?? []).length === 0;

  if (allAnalysisEmpty) {
    const hasExplanation =
      (output.assumptions ?? []).length > 0 ||
      (output.uncoveredContext ?? []).length > 0;
    if (!hasExplanation) {
      errors.push("All analysis arrays are empty but no explanation in assumptions or uncoveredContext");
    }
  }

  // Rule 3: sourceArtifacts hash validation
  if (output.sourceArtifacts) {
    if (output.sourceArtifacts.inputManifestHash !== manifest.policySnapshotHash) {
      errors.push("sourceArtifacts.inputManifestHash mismatch");
    }
    if (output.sourceArtifacts.policySnapshotHash !== manifest.policySnapshotHash) {
      errors.push("sourceArtifacts.policySnapshotHash mismatch");
    }
  }

  return errors;
}

export async function reviewStage(options: StageOptions): Promise<{ stageArtifactPath: string }> {
  const cwd = process.cwd();
  const { runId, stage, adapter } = options;
  const inputDir = resolve(cwd, getInputDir(runId));
  const runDir = resolve(cwd, `.change-assurance/runs/${runId}`);

  if (!existsSync(inputDir)) {
    throw new StageError(`Run not found: ${runId}`);
  }

  const manifestPath = resolve(inputDir, INPUT_ARTIFACTS.INPUT_MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as InputManifest;

  const policySnapshotPath = resolve(inputDir, INPUT_ARTIFACTS.POLICY_SNAPSHOT);
  const policySnapshotContent = readFileSync(policySnapshotPath, "utf-8");

  const changedFilesPath = resolve(inputDir, INPUT_ARTIFACTS.CHANGED_FILES);
  const changedFilesContent = readFileSync(changedFilesPath, "utf-8");

  const gitStatePath = resolve(inputDir, INPUT_ARTIFACTS.GIT_STATE);
  const gitStateContent = readFileSync(gitStatePath, "utf-8");

  const diffPath = resolve(inputDir, INPUT_ARTIFACTS.DIFF_PATCH);
  const diffContent = readFileSync(diffPath, "utf-8");

  if (sha256(policySnapshotContent) !== manifest.policySnapshotHash) {
    throw new StageError("policy.snapshot.yaml hash mismatch");
  }
  if (sha256(changedFilesContent) !== manifest.changedFilesHash) {
    throw new StageError("changed-files.json hash mismatch");
  }
  if (sha256(gitStateContent) !== manifest.gitStateHash) {
    throw new StageError("git-state.json hash mismatch");
  }
  if (sha256(diffContent) !== manifest.diffHash) {
    throw new StageError("diff.patch hash mismatch");
  }

  const currentHead = getHeadCommit();
  const gitState = JSON.parse(gitStateContent);
  if (currentHead !== gitState.headCommit) {
    throw new StageError(`HEAD changed: expected ${gitState.headCommit}, got ${currentHead}`);
  }

  let verificationLedgerHash: string | undefined;
  const verificationLedgerPath = resolve(cwd, getVerificationLedgerPath(runId));
  if (existsSync(verificationLedgerPath)) {
    verificationLedgerHash = sha256(readFileSync(verificationLedgerPath, "utf-8"));
  }

  const prompt = buildChangeMapPrompt(diffContent, changedFilesContent, policySnapshotContent);

  const stagesDir = resolve(cwd, getStagesDir(runId));
  mkdirSync(stagesDir, { recursive: true });

  let rawMessages: unknown;
  let structuredOutput: unknown;
  try {
    const result = await adapter.runStage({
      stage,
      runDirectory: cwd,
      prompt,
      schema: CHANGE_MAP_SCHEMA,
    });
    rawMessages = result.rawOutput;
    structuredOutput = result.structuredOutput;
  } catch (error) {
    const rawPath = resolve(cwd, getStageRawArtifactPath(runId, stage));
    writeFileSync(rawPath, JSON.stringify({ error: String(error) }, null, 2));
    throw error;
  }

  const rawPath = resolve(cwd, getStageRawArtifactPath(runId, stage));
  writeFileSync(rawPath, JSON.stringify(rawMessages, null, 2));

  const validationErrors = validateChangeMap(structuredOutput);
  if (validationErrors.length > 0) {
    throw new StageError(`Invalid output: ${validationErrors.join(", ")}`);
  }

  const changeMap = structuredOutput as ChangeMap;
  const refErrors = validateEvidenceRefs(changeMap, runDir);
  if (refErrors.length > 0) {
    throw new StageError(`Invalid evidenceRefs: ${refErrors.join(", ")}`);
  }

  // Adequacy gate
  const changedFiles = JSON.parse(changedFilesContent) as Array<{ path: string }>;
  const adequacyErrors = validateAdequacy(changeMap, changedFiles, manifest);
  if (adequacyErrors.length > 0) {
    throw new StageError(`Adequacy gate failed: ${adequacyErrors.join(", ")}`);
  }

  const artifact: ChangeMap = {
    runId,
    stage: "change-map",
    createdAt: new Date().toISOString(),
    sourceArtifacts: {
      inputManifestHash: manifest.policySnapshotHash,
      policySnapshotHash: manifest.policySnapshotHash,
      verificationLedgerHash,
    },
    changedModules: changeMap.changedModules,
    behaviorChanges: changeMap.behaviorChanges,
    riskAreas: changeMap.riskAreas,
    reviewPriorities: changeMap.reviewPriorities,
    uncoveredContext: changeMap.uncoveredContext,
    assumptions: changeMap.assumptions,
  };

  const artifactPath = resolve(cwd, getStageArtifactPath(runId, stage));
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

  return { stageArtifactPath: artifactPath };
}

function buildChangeMapPrompt(diff: string, changedFiles: string, policy: string): string {
  return `You are performing a change-map analysis for a code review.

TASK: Identify changed modules, behavior changes, risk areas, and review priorities.

CONSTRAINTS:
- Only analyze the provided diff and changed files
- Do NOT output blockers, issues, or merge recommendations
- All behavior changes must reference evidence from the diff
- If information is insufficient, add to uncoveredContext
- Do NOT claim any verification commands were executed

INPUT:
- Diff: ${diff.substring(0, 5000)}
- Changed Files: ${changedFiles}
- Policy: ${policy}

OUTPUT FORMAT (JSON):
{
  "changedModules": [{"path": "...", "role": "...", "changeSummary": "..."}],
  "behaviorChanges": [{"summary": "...", "evidenceRefs": ["input/diff.patch"]}],
  "riskAreas": [{"area": "...", "reason": "...", "evidenceRefs": ["input/diff.patch"]}],
  "reviewPriorities": [{"priority": "high|medium|low", "area": "...", "reason": "..."}],
  "uncoveredContext": [{"area": "...", "reason": "..."}],
  "assumptions": ["..."]
}`;
}

const CHANGE_MAP_SCHEMA = {
  type: "object",
  properties: {
    changedModules: { type: "array" },
    behaviorChanges: { type: "array" },
    riskAreas: { type: "array" },
    reviewPriorities: { type: "array" },
    uncoveredContext: { type: "array" },
    assumptions: { type: "array" },
  },
  required: ["changedModules", "behaviorChanges", "riskAreas", "reviewPriorities", "uncoveredContext", "assumptions"],
};
