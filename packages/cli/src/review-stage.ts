import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  getInputDir,
  getStagesDir,
  getStageArtifactPath,
  getStageRawArtifactPath,
  getVerificationLedgerPath,
  INPUT_ARTIFACTS,
  getHeadCommit,
  getFileContentAtCommit,
  fileExistsAtCommit,
} from "@change-assurance/core";
import type {
  InputManifest,
  ChangeMap,
  BehaviorReview,
  TestReview,
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

interface SourceEvidenceRef {
  commit: string;
  path: string;
  startLine: number;
  endLine: number;
}

function parseSourceEvidenceRef(ref: string): SourceEvidenceRef | null {
  // Format: git:<commit>:<path>#L<start>-L<end> or git:<commit>:<path>#L<line>
  const rangeMatch = ref.match(/^git:([a-f0-9]+):(.+)#L(\d+)-L(\d+)$/);
  if (rangeMatch) {
    return {
      commit: rangeMatch[1],
      path: rangeMatch[2],
      startLine: parseInt(rangeMatch[3], 10),
      endLine: parseInt(rangeMatch[4], 10),
    };
  }
  const singleMatch = ref.match(/^git:([a-f0-9]+):(.+)#L(\d+)$/);
  if (singleMatch) {
    const line = parseInt(singleMatch[3], 10);
    return {
      commit: singleMatch[1],
      path: singleMatch[2],
      startLine: line,
      endLine: line,
    };
  }
  return null;
}

function validateSourceEvidenceRefs(output: BehaviorReview, expectedCommit: string): string[] {
  const errors: string[] = [];

  const allRefs = [
    ...output.reviewedAreas.flatMap((a) => a.evidenceRefs ?? []),
    ...output.findings.flatMap((f) => f.evidenceRefs ?? []),
  ];

  for (const ref of allRefs) {
    const parsed = parseSourceEvidenceRef(ref);
    if (!parsed) {
      errors.push(`Invalid evidenceRef format: ${ref}`);
      continue;
    }

    if (parsed.commit !== expectedCommit) {
      errors.push(`evidenceRef commit mismatch: expected ${expectedCommit}, got ${parsed.commit} in ${ref}`);
      continue;
    }

    if (!fileExistsAtCommit(parsed.commit, parsed.path)) {
      errors.push(`evidenceRef path not found at commit: ${parsed.path} in ${ref}`);
      continue;
    }

    const content = getFileContentAtCommit(parsed.commit, parsed.path);
    const lineCount = content.split("\n").length;
    if (parsed.startLine < 1 || parsed.endLine > lineCount || parsed.startLine > parsed.endLine) {
      errors.push(`evidenceRef line range invalid: L${parsed.startLine}-L${parsed.endLine} (file has ${lineCount} lines) in ${ref}`);
    }
  }

  return errors;
}

function validateBehaviorReviewForbiddenFields(output: any): string[] {
  const errors: string[] = [];
  const forbiddenFields = ["blocker", "issue", "severity", "blocking", "approve", "mergeRecommendation", "requestChanges"];
  for (const field of forbiddenFields) {
    if (field in output) {
      errors.push(`Forbidden field: ${field}`);
    }
  }
  return errors;
}

function validateBehaviorReview(output: BehaviorReview): string[] {
  const errors: string[] = [];

  // Each finding must have required fields
  for (const finding of output.findings) {
    if (!finding.title || finding.title.trim() === "") {
      errors.push(`Finding ${finding.id}: title is required`);
    }
    if (!finding.trigger || finding.trigger.trim() === "") {
      errors.push(`Finding ${finding.id}: trigger is required`);
    }
    if (!finding.impact || finding.impact.trim() === "") {
      errors.push(`Finding ${finding.id}: impact is required`);
    }
    if (!finding.recommendation || finding.recommendation.trim() === "") {
      errors.push(`Finding ${finding.id}: recommendation is required`);
    }
    if (!finding.observedBehavior || finding.observedBehavior.trim() === "") {
      errors.push(`Finding ${finding.id}: observedBehavior is required`);
    }
  }

  // Empty findings must have reviewedAreas or uncoveredContext explanation
  if (output.findings.length === 0) {
    const hasReviewedAreas = output.reviewedAreas.length > 0;
    const hasUncoveredContext = output.uncoveredContext.length > 0;
    if (!hasReviewedAreas && !hasUncoveredContext) {
      errors.push("Empty findings must have reviewedAreas or uncoveredContext to explain coverage");
    }
  }

  return errors;
}

function validateTestReviewForbiddenFields(output: any): string[] {
  const errors: string[] = [];
  const forbiddenFields = ["blocker", "issue", "severity", "blocking", "approve", "mergeRecommendation", "requestChanges"];
  for (const field of forbiddenFields) {
    if (field in output) {
      errors.push(`Forbidden field: ${field}`);
    }
  }
  return errors;
}

function validateTestReview(output: TestReview): string[] {
  const errors: string[] = [];

  // Each reviewedBehavior with adequately_covered must have testEvidenceRefs
  for (const rb of output.reviewedBehaviors) {
    if (rb.assessment === "adequately_covered" && (!rb.testEvidenceRefs || rb.testEvidenceRefs.length === 0)) {
      errors.push(`reviewedBehavior "${rb.behavior}": adequately_covered requires testEvidenceRefs`);
    }
  }

  // Each finding must have required fields
  for (const finding of output.findings) {
    if (!finding.behavior || finding.behavior.trim() === "") {
      errors.push(`Finding ${finding.id}: behavior is required`);
    }
    if (!finding.observedTestCoverage || finding.observedTestCoverage.trim() === "") {
      errors.push(`Finding ${finding.id}: observedTestCoverage is required`);
    }
    if (!finding.impact || finding.impact.trim() === "") {
      errors.push(`Finding ${finding.id}: impact is required`);
    }
    if (!finding.recommendation || finding.recommendation.trim() === "") {
      errors.push(`Finding ${finding.id}: recommendation is required`);
    }
  }

  return errors;
}

function validateTestReviewVerificationConsistency(
  output: TestReview,
  verificationLedger?: { commands?: Array<{ id: string; status: string }>; summary?: { failed: number } },
): string[] {
  const errors: string[] = [];
  if (!verificationLedger) return errors;

  const hasFailedTests = (verificationLedger.summary?.failed ?? 0) > 0 ||
    (verificationLedger.commands ?? []).some((c) => c.status === "failed");

  if (hasFailedTests && output.verificationAssessment.testCommandStatus === "passed") {
    errors.push("verificationAssessment says passed but verification ledger has failed tests");
  }

  return errors;
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

function validateAdequacy(output: ChangeMap, changedFiles: Array<{ path: string }>, manifest: InputManifest, inputManifestHash: string): string[] {
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

  // Rule 3: sourceArtifacts hash validation (required)
  if (!output.sourceArtifacts) {
    errors.push("sourceArtifacts is required");
  } else {
    if (output.sourceArtifacts.inputManifestHash !== inputManifestHash) {
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
  const manifestContent = readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(manifestContent) as InputManifest;
  const inputManifestHash = sha256(manifestContent);

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

  const gitState = JSON.parse(gitStateContent);
  const currentHead = getHeadCommit();
  if (currentHead !== gitState.headCommit) {
    throw new StageError(`HEAD changed: expected ${gitState.headCommit}, got ${currentHead}`);
  }

  let verificationLedgerHash: string | undefined;
  const verificationLedgerPath = resolve(cwd, getVerificationLedgerPath(runId));
  if (existsSync(verificationLedgerPath)) {
    verificationLedgerHash = sha256(readFileSync(verificationLedgerPath, "utf-8"));
  }

  const stagesDir = resolve(cwd, getStagesDir(runId));
  mkdirSync(stagesDir, { recursive: true });

  if (stage === "change-map") {
    return runChangeMapStage({
      runId, runDir, cwd, adapter, manifest, diffContent, changedFilesContent,
      policySnapshotContent, verificationLedgerHash, stagesDir, inputManifestHash,
    });
  }

  if (stage === "behavior-review") {
    return runBehaviorReviewStage({
      runId, runDir, cwd, adapter, manifest, diffContent, changedFilesContent,
      gitState, verificationLedgerHash, stagesDir, inputManifestHash,
    });
  }

  if (stage === "test-review") {
    return runTestReviewStage({
      runId, runDir, cwd, adapter, manifest, diffContent, changedFilesContent,
      gitState, verificationLedgerHash, stagesDir, inputManifestHash,
    });
  }

  throw new StageError(`Unsupported stage: ${stage}`);
}

async function runChangeMapStage(ctx: {
  runId: string; runDir: string; cwd: string; adapter: ReviewStageAdapter;
  manifest: InputManifest; diffContent: string; changedFilesContent: string;
  policySnapshotContent: string; verificationLedgerHash?: string; stagesDir: string;
  inputManifestHash: string;
}): Promise<{ stageArtifactPath: string }> {
  const { runId, runDir, cwd, adapter, manifest, diffContent, changedFilesContent,
    policySnapshotContent, verificationLedgerHash, inputManifestHash } = ctx;
  const stage = "change-map";

  const prompt = buildChangeMapPrompt(diffContent, changedFilesContent, policySnapshotContent);

  let rawMessages: unknown;
  let structuredOutput: unknown;
  try {
    const result = await adapter.runStage({ stage, runDirectory: cwd, prompt, schema: CHANGE_MAP_SCHEMA });
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

  const changedFiles = JSON.parse(changedFilesContent) as Array<{ path: string }>;
  const adequacyErrors = validateAdequacy(changeMap, changedFiles, manifest, inputManifestHash);
  if (adequacyErrors.length > 0) {
    throw new StageError(`Adequacy gate failed: ${adequacyErrors.join(", ")}`);
  }

  const artifact: ChangeMap = {
    runId, stage: "change-map", createdAt: new Date().toISOString(),
    sourceArtifacts: {
      inputManifestHash,
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

async function runBehaviorReviewStage(ctx: {
  runId: string; runDir: string; cwd: string; adapter: ReviewStageAdapter;
  manifest: InputManifest; diffContent: string; changedFilesContent: string;
  gitState: { headCommit: string }; verificationLedgerHash?: string; stagesDir: string;
  inputManifestHash: string;
}): Promise<{ stageArtifactPath: string }> {
  const { runId, cwd, adapter, diffContent, changedFilesContent,
    gitState, verificationLedgerHash, stagesDir, inputManifestHash } = ctx;
  const stage = "behavior-review";

  // Prerequisite: change-map.json must exist and be valid
  const changeMapPath = resolve(stagesDir, "change-map.json");
  if (!existsSync(changeMapPath)) {
    throw new StageError("change-map.json not found. Run change-map stage first.");
  }

  const changeMapContent = readFileSync(changeMapPath, "utf-8");
  const changeMapHash = sha256(changeMapContent);

  // Build source context from frozen commit for changed files
  const changedFiles = JSON.parse(changedFilesContent) as Array<{ path: string }>;
  const sourceContext = buildSourceContext(changedFiles, gitState.headCommit);

  const prompt = buildBehaviorReviewPrompt(diffContent, changedFilesContent, changeMapContent, gitState.headCommit, sourceContext);

  let rawMessages: unknown;
  let structuredOutput: unknown;
  try {
    const result = await adapter.runStage({ stage, runDirectory: cwd, prompt, schema: BEHAVIOR_REVIEW_SCHEMA });
    rawMessages = result.rawOutput;
    structuredOutput = result.structuredOutput;
  } catch (error) {
    const rawPath = resolve(cwd, getStageRawArtifactPath(runId, stage));
    writeFileSync(rawPath, JSON.stringify({ error: String(error) }, null, 2));
    throw error;
  }

  const rawPath = resolve(cwd, getStageRawArtifactPath(runId, stage));
  writeFileSync(rawPath, JSON.stringify(rawMessages, null, 2));

  // Validate forbidden fields
  const forbiddenErrors = validateBehaviorReviewForbiddenFields(structuredOutput);
  if (forbiddenErrors.length > 0) {
    throw new StageError(`Invalid output: ${forbiddenErrors.join(", ")}`);
  }

  const behaviorReview = structuredOutput as BehaviorReview;

  // Validate source evidence refs against frozen commit
  const refErrors = validateSourceEvidenceRefs(behaviorReview, gitState.headCommit);
  if (refErrors.length > 0) {
    throw new StageError(`Invalid evidenceRefs: ${refErrors.join(", ")}`);
  }

  // Validate finding structure
  const reviewErrors = validateBehaviorReview(behaviorReview);
  if (reviewErrors.length > 0) {
    throw new StageError(`Invalid behavior review: ${reviewErrors.join(", ")}`);
  }

  const artifact: BehaviorReview = {
    runId, stage: "behavior-review", createdAt: new Date().toISOString(),
    sourceArtifacts: {
      inputManifestHash,
      changeMapHash,
      verificationLedgerHash,
    },
    reviewedAreas: behaviorReview.reviewedAreas,
    findings: behaviorReview.findings,
    uncoveredContext: behaviorReview.uncoveredContext,
    assumptions: behaviorReview.assumptions,
  };

  const artifactPath = resolve(cwd, getStageArtifactPath(runId, stage));
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
  return { stageArtifactPath: artifactPath };
}

async function runTestReviewStage(ctx: {
  runId: string; runDir: string; cwd: string; adapter: ReviewStageAdapter;
  manifest: InputManifest; diffContent: string; changedFilesContent: string;
  gitState: { headCommit: string }; verificationLedgerHash?: string; stagesDir: string;
  inputManifestHash: string;
}): Promise<{ stageArtifactPath: string }> {
  const { runId, cwd, adapter, diffContent, changedFilesContent,
    gitState, verificationLedgerHash, stagesDir, inputManifestHash } = ctx;
  const stage = "test-review";

  // Prerequisite: change-map.json and behavior-review.json must exist
  const changeMapPath = resolve(stagesDir, "change-map.json");
  if (!existsSync(changeMapPath)) {
    throw new StageError("change-map.json not found. Run change-map stage first.");
  }
  const behaviorReviewPath = resolve(stagesDir, "behavior-review.json");
  if (!existsSync(behaviorReviewPath)) {
    throw new StageError("behavior-review.json not found. Run behavior-review stage first.");
  }

  const changeMapContent = readFileSync(changeMapPath, "utf-8");
  const changeMapHash = sha256(changeMapContent);
  const behaviorReviewContent = readFileSync(behaviorReviewPath, "utf-8");
  const behaviorReviewHash = sha256(behaviorReviewContent);

  // Check verification ledger
  const verificationLedgerPath = resolve(cwd, getVerificationLedgerPath(runId));
  const hasVerificationLedger = existsSync(verificationLedgerPath);
  let verificationLedger: any;
  let verificationNote: string;
  if (hasVerificationLedger) {
    verificationLedger = JSON.parse(readFileSync(verificationLedgerPath, "utf-8"));
    const failedCount = verificationLedger.summary?.failed ?? 0;
    const failedCmds = (verificationLedger.commands ?? [])
      .filter((c: any) => c.status === "failed")
      .map((c: any) => c.id);
    verificationNote = `- Verification Ledger: status=${verificationLedger.runStatus}, failed=${failedCount}, failedCommands=[${failedCmds.join(", ")}]`;
  } else {
    verificationNote = "- Verification Ledger: NOT AVAILABLE. Set testCommandStatus to \"unavailable\".";
  }

  // Build source context
  const changedFiles = JSON.parse(changedFilesContent) as Array<{ path: string }>;
  const sourceContext = buildSourceContext(changedFiles, gitState.headCommit);

  const prompt = buildTestReviewPrompt(
    diffContent, changedFilesContent, changeMapContent, behaviorReviewContent,
    gitState.headCommit, sourceContext, verificationNote,
  );

  let rawMessages: unknown;
  let structuredOutput: unknown;
  try {
    const result = await adapter.runStage({ stage, runDirectory: cwd, prompt, schema: TEST_REVIEW_SCHEMA });
    rawMessages = result.rawOutput;
    structuredOutput = result.structuredOutput;
  } catch (error) {
    const rawPath = resolve(cwd, getStageRawArtifactPath(runId, stage));
    writeFileSync(rawPath, JSON.stringify({ error: String(error) }, null, 2));
    throw error;
  }

  const rawPath = resolve(cwd, getStageRawArtifactPath(runId, stage));
  writeFileSync(rawPath, JSON.stringify(rawMessages, null, 2));

  // Validate forbidden fields
  const forbiddenErrors = validateTestReviewForbiddenFields(structuredOutput);
  if (forbiddenErrors.length > 0) {
    throw new StageError(`Invalid output: ${forbiddenErrors.join(", ")}`);
  }

  const testReview = structuredOutput as TestReview;

  // Enforce: no verification ledger → testCommandStatus must be unavailable
  if (!hasVerificationLedger) {
    testReview.verificationAssessment.testCommandStatus = "unavailable";
  }

  // Validate source evidence refs
  const allRefs = [
    ...testReview.reviewedBehaviors.flatMap((rb) => [...(rb.implementationEvidenceRefs ?? []), ...(rb.testEvidenceRefs ?? [])]),
    ...testReview.findings.flatMap((f) => f.evidenceRefs ?? []),
  ];
  for (const ref of allRefs) {
    const parsed = parseSourceEvidenceRef(ref);
    if (!parsed) {
      throw new StageError(`Invalid evidenceRef format: ${ref}`);
    }
    if (parsed.commit !== gitState.headCommit) {
      throw new StageError(`evidenceRef commit mismatch: expected ${gitState.headCommit}, got ${parsed.commit} in ${ref}`);
    }
    if (!fileExistsAtCommit(parsed.commit, parsed.path)) {
      throw new StageError(`evidenceRef path not found at commit: ${parsed.path} in ${ref}`);
    }
    const content = getFileContentAtCommit(parsed.commit, parsed.path);
    const lineCount = content.split("\n").length;
    if (parsed.startLine < 1 || parsed.endLine > lineCount || parsed.startLine > parsed.endLine) {
      throw new StageError(`evidenceRef line range invalid: L${parsed.startLine}-L${parsed.endLine} (file has ${lineCount} lines) in ${ref}`);
    }
  }

  // Validate test review structure
  const reviewErrors = validateTestReview(testReview);
  if (reviewErrors.length > 0) {
    throw new StageError(`Invalid test review: ${reviewErrors.join(", ")}`);
  }

  // Validate verification consistency
  const consistencyErrors = validateTestReviewVerificationConsistency(testReview, verificationLedger);
  if (consistencyErrors.length > 0) {
    throw new StageError(`Verification inconsistency: ${consistencyErrors.join(", ")}`);
  }

  const artifact: TestReview = {
    runId, stage: "test-review", createdAt: new Date().toISOString(),
    sourceArtifacts: {
      inputManifestHash,
      changeMapHash,
      behaviorReviewHash,
      verificationLedgerHash,
    },
    reviewedBehaviors: testReview.reviewedBehaviors,
    findings: testReview.findings,
    verificationAssessment: testReview.verificationAssessment,
    uncoveredContext: testReview.uncoveredContext,
    assumptions: testReview.assumptions,
  };

  const artifactPath = resolve(cwd, getStageArtifactPath(runId, stage));
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
  return { stageArtifactPath: artifactPath };
}

function buildTestReviewPrompt(
  diff: string,
  changedFiles: string,
  changeMapJson: string,
  behaviorReviewJson: string,
  headCommit: string,
  sourceContext: string,
  verificationNote: string,
): string {
  return `You are performing a test effectiveness review for a code review.

TASK: For each key behavior change, determine whether adequate tests exist and whether those tests actually assert critical results or failure paths.

CONSTRAINTS:
- Do NOT judge test adequacy by "test file exists." You must check actual test content and assertions.
- Prioritize high-risk behaviors from the change-map and behavior-review.
- Each reviewedBehavior must have implementationEvidenceRefs pointing to the implementation.
- When you say "adequately_covered", you MUST provide testEvidenceRefs pointing to test source code.
- When a test is missing or weak, specify which behavior or failure path is untested.
- Do NOT generalize ("tests are insufficient"). Each gap must reference a specific behavior.
- All evidence refs MUST use the format: git:<commit>:<path>#L<start>-L<end> or git:<commit>:<path>#L<line>
- The commit in evidence refs MUST be: ${headCommit}
- Line numbers MUST match the SOURCE CONTEXT provided below.
- Do NOT output blockers, merge recommendations, or request-changes.
- Do NOT describe unexecuted commands as executed.

INPUT:
- Diff: ${diff.substring(0, 5000)}
- Changed Files: ${changedFiles}
- Change Map: ${changeMapJson}
- Behavior Review: ${behaviorReviewJson}
${verificationNote}
${sourceContext}

OUTPUT FORMAT (JSON):
{
  "reviewedBehaviors": [{
    "behavior": "...",
    "implementationEvidenceRefs": ["git:${headCommit}:path#L1-L10"],
    "testEvidenceRefs": ["git:${headCommit}:test-path#L1-L10"],
    "assessment": "adequately_covered|partially_covered|not_covered|not_applicable|needs_context",
    "rationale": "..."
  }],
  "findings": [{
    "id": "T001",
    "title": "...",
    "type": "missing_test|missing_failure_path_test|weak_assertion|test_contract_gap|test_execution_gap",
    "candidateImpact": "material|advisory|needs_context",
    "behavior": "...",
    "observedTestCoverage": "...",
    "impact": "...",
    "recommendation": "...",
    "evidenceRefs": ["git:${headCommit}:path#L1-L10"],
    "confidence": "high|medium|low"
  }],
  "verificationAssessment": {
    "testCommandStatus": "passed|failed|not_required|unavailable",
    "note": "..."
  },
  "uncoveredContext": [{"area": "...", "reason": "..."}],
  "assumptions": ["..."]
}`;
}

const TEST_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    reviewedBehaviors: { type: "array" },
    findings: { type: "array" },
    verificationAssessment: { type: "object" },
    uncoveredContext: { type: "array" },
    assumptions: { type: "array" },
  },
  required: ["reviewedBehaviors", "findings", "verificationAssessment", "uncoveredContext", "assumptions"],
};

function buildSourceContext(changedFiles: Array<{ path: string }>, headCommit: string): string {
  const sections: string[] = [];
  for (const file of changedFiles) {
    try {
      const content = getFileContentAtCommit(headCommit, file.path);
      const lines = content.split("\n");
      const numbered = lines.map((line, i) => `${i + 1}: ${line}`).join("\n");
      sections.push(`\n--- SOURCE: git:${headCommit}:${file.path} ---\n${numbered}\n--- END SOURCE ---`);
    } catch {
      // File might not exist at commit (e.g., deleted files)
      sections.push(`\n--- SOURCE: git:${headCommit}:${file.path} ---\n[File not available at this commit]\n--- END SOURCE ---`);
    }
  }
  return sections.join("\n");
}

function buildBehaviorReviewPrompt(
  diff: string,
  changedFiles: string,
  changeMapJson: string,
  headCommit: string,
  sourceContext: string,
): string {
  return `You are performing a behavior and regression review for a code review.

TASK: Review the changed code for success paths, failure paths, state transitions, boundary conditions, and regression risks.

CONSTRAINTS:
- Only review behavior and regression risk. Do NOT evaluate code style.
- Prioritize review areas marked high-priority in the change-map.
- Every conclusion must include trigger conditions and impact chain.
- Separate observed facts from derived risks.
- If you cannot confirm something, add to uncoveredContext. Do NOT speculate.
- Do NOT describe unexecuted commands as executed.
- Do NOT output blockers, merge recommendations, or request-changes.
- All evidence refs MUST use the format: git:<commit>:<path>#L<start>-L<end>
- The commit in evidence refs MUST be: ${headCommit}
- Line numbers in evidence refs MUST match the SOURCE CONTEXT provided below. Count lines starting from 1. Do NOT guess or infer line numbers from the diff.

INPUT:
- Diff: ${diff.substring(0, 5000)}
- Changed Files: ${changedFiles}
- Change Map: ${changeMapJson}
${sourceContext}

OUTPUT FORMAT (JSON):
{
  "reviewedAreas": [{"area": "...", "paths": ["..."], "focus": "...", "evidenceRefs": ["git:${headCommit}:path#L1-L10"]}],
  "findings": [{
    "id": "F001",
    "title": "...",
    "type": "success_path|failure_path|state_transition|boundary_condition|regression_risk",
    "candidateImpact": "merge_blocking|material|advisory",
    "trigger": "...",
    "observedBehavior": "...",
    "expectedBehavior": "...",
    "impact": "...",
    "recommendation": "...",
    "evidenceRefs": ["git:${headCommit}:path#L1-L10"],
    "confidence": "high|medium|low"
  }],
  "uncoveredContext": [{"area": "...", "reason": "..."}],
  "assumptions": ["..."]
}`;
}

const BEHAVIOR_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    reviewedAreas: { type: "array" },
    findings: { type: "array" },
    uncoveredContext: { type: "array" },
    assumptions: { type: "array" },
  },
  required: ["reviewedAreas", "findings", "uncoveredContext", "assumptions"],
};

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
    sourceArtifacts: { type: "object" },
  },
  required: ["changedModules", "behaviorChanges", "riskAreas", "reviewPriorities", "uncoveredContext", "assumptions", "sourceArtifacts"],
};
