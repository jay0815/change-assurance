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
  EvidenceAudit,
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

function validateTestReviewEvidenceRefs(output: TestReview, expectedCommit: string): string[] {
  const errors: string[] = [];

  const allRefs = [
    ...output.reviewedBehaviors.flatMap((rb) => [...(rb.implementationEvidenceRefs ?? []), ...(rb.testEvidenceRefs ?? [])]),
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

function validateAdequacy(output: ChangeMap, changedFiles: Array<{ path: string }>): string[] {
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

  if (stage === "evidence-audit") {
    return runEvidenceAuditStage({
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
  const adequacyErrors = validateAdequacy(changeMap, changedFiles);
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

  // Validate source evidence refs (reuse shared validation)
  const testReviewRefErrors = validateTestReviewEvidenceRefs(testReview, gitState.headCommit);
  if (testReviewRefErrors.length > 0) {
    throw new StageError(`Invalid evidenceRefs: ${testReviewRefErrors.join(", ")}`);
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

// Evidence Audit stage

const IMPACT_RANK: Record<string, number> = {
  merge_blocking: 4,
  material: 3,
  advisory: 2,
  needs_context: 1,
};

function validateEvidenceAuditForbiddenFields(output: any): string[] {
  const errors: string[] = [];
  const forbiddenFields = ["blocker", "issue", "severity", "blocking", "approve", "mergeRecommendation", "requestChanges"];
  for (const field of forbiddenFields) {
    if (field in output) {
      errors.push(`Forbidden field: ${field}`);
    }
  }
  return errors;
}

function validateEvidenceAudit(
  output: EvidenceAudit,
  behaviorReview: BehaviorReview,
  testReview: TestReview,
): string[] {
  const errors: string[] = [];

  // Build valid finding refs
  const validBrRefs = new Set(behaviorReview.findings.map((f) => f.id));
  const validTrRefs = new Set(testReview.findings.map((f) => f.id));
  const allFindingRefs = new Set([...validBrRefs, ...validTrRefs]);

  // Build evidence ref lookup: findingId → Set<evidenceRef>
  const brEvidenceMap = new Map<string, Set<string>>();
  for (const f of behaviorReview.findings) {
    brEvidenceMap.set(f.id, new Set(f.evidenceRefs ?? []));
  }
  const trEvidenceMap = new Map<string, Set<string>>();
  for (const f of testReview.findings) {
    trEvidenceMap.set(f.id, new Set(f.evidenceRefs ?? []));
  }

  // Build source finding impact lookup
  const brImpactMap = new Map<string, string>();
  for (const f of behaviorReview.findings) {
    brImpactMap.set(f.id, f.candidateImpact);
  }
  const trImpactMap = new Map<string, string>();
  for (const f of testReview.findings) {
    trImpactMap.set(f.id, f.candidateImpact);
  }

  for (let i = 0; i < output.auditedFindings.length; i++) {
    const af = output.auditedFindings[i];

    // Validate sourceFindingRef exists
    if (!allFindingRefs.has(af.sourceFindingRef)) {
      errors.push(`sourceFindingRef not found: ${af.sourceFindingRef}`);
      continue;
    }

    // Validate verifiedEvidenceRefs are subset of source finding's evidenceRefs
    const sourceEvidence = af.sourceStage === "behavior-review"
      ? brEvidenceMap.get(af.sourceFindingRef) ?? new Set<string>()
      : trEvidenceMap.get(af.sourceFindingRef) ?? new Set<string>();

    for (const ref of af.verifiedEvidenceRefs) {
      if (!sourceEvidence.has(ref)) {
        errors.push(`verifiedEvidenceRef ${ref} not in source finding ${af.sourceFindingRef}`);
      }
    }

    // hypothesis must not be merge_blocking
    if (af.evidenceClass === "hypothesis" && af.effectiveCandidateImpact === "merge_blocking") {
      errors.push(`hypothesis finding ${af.sourceFindingRef} cannot be merge_blocking`);
    }

    // effectiveCandidateImpact must not exceed source finding's candidateImpact
    const sourceImpact = af.sourceStage === "behavior-review"
      ? brImpactMap.get(af.sourceFindingRef)
      : trImpactMap.get(af.sourceFindingRef);

    if (sourceImpact && af.effectiveCandidateImpact && af.effectiveCandidateImpact !== "needs_context") {
      const sourceRank = IMPACT_RANK[sourceImpact] ?? 0;
      const auditRank = IMPACT_RANK[af.effectiveCandidateImpact] ?? 0;
      if (auditRank > sourceRank) {
        errors.push(`cannot upgrade ${af.sourceFindingRef} from ${sourceImpact} to ${af.effectiveCandidateImpact}`);
      }
    }

    // rejected must have null effectiveCandidateImpact
    if (af.disposition === "rejected" && af.effectiveCandidateImpact !== null) {
      errors.push(`rejected finding ${af.sourceFindingRef} must have null effectiveCandidateImpact`);
    }

    // deduplicatedWith must reference a valid audit finding
    if (af.deduplicatedWith !== undefined) {
      if (!allFindingRefs.has(af.deduplicatedWith)) {
        errors.push(`deduplicatedWith references unknown finding: ${af.deduplicatedWith}`);
      }
    }
  }

  // Summary must match actual counts
  const dispositionToKey: Record<string, keyof { accepted: number; downgraded: number; needsContext: number; rejected: number }> = {
    accepted: "accepted",
    downgraded: "downgraded",
    needs_context: "needsContext",
    rejected: "rejected",
  };
  const counts = { accepted: 0, downgraded: 0, needsContext: 0, rejected: 0 };
  for (const af of output.auditedFindings) {
    const key = dispositionToKey[af.disposition];
    if (key) {
      counts[key]++;
    }
  }
  if (counts.accepted !== output.summary.accepted) {
    errors.push(`summary.accepted mismatch: expected ${counts.accepted}, got ${output.summary.accepted}`);
  }
  if (counts.downgraded !== output.summary.downgraded) {
    errors.push(`summary.downgraded mismatch: expected ${counts.downgraded}, got ${output.summary.downgraded}`);
  }
  if (counts.needsContext !== output.summary.needsContext) {
    errors.push(`summary.needsContext mismatch: expected ${counts.needsContext}, got ${output.summary.needsContext}`);
  }

  if (counts.rejected !== output.summary.rejected) {
    errors.push(`summary.rejected mismatch: expected ${counts.rejected}, got ${output.summary.rejected}`);
  }

  return errors;
}

function buildEvidenceAuditPrompt(
  behaviorReviewJson: string,
  testReviewJson: string,
  _headCommit: string,
): string {
  // Build per-finding evidence lists for the prompt
  const brFindingsList = JSON.parse(behaviorReviewJson).findings.map((f: any) =>
    `  - [${f.id}] ${f.title} (impact: ${f.candidateImpact}, confidence: ${f.confidence})\n    evidenceRefs: ${(f.evidenceRefs ?? []).join(", ")}`,
  ).join("\n");
  const trFindingsList = JSON.parse(testReviewJson).findings.map((f: any) =>
    `  - [${f.id}] ${f.title} (impact: ${f.candidateImpact}, confidence: ${f.confidence})\n    evidenceRefs: ${(f.evidenceRefs ?? []).join(", ")}`,
  ).join("\n");

  return `You are performing an evidence audit for a code review.

TASK: Evaluate whether each candidate finding from previous stages has sufficient evidence. Classify evidence and determine disposition.

CONSTRAINTS:
1. You are NOT a new reviewer. Do NOT add new findings or issues.
2. You can ONLY evaluate whether existing findings have sufficient evidence.
3. Classify each finding as observed / derived / hypothesis.
4. When evidence is insufficient, prefer needs_context. Do NOT speculate.
5. You MUST NOT upgrade any finding's candidateImpact level.
6. Do NOT output blockers, merge recommendations, or request-changes.
7. For duplicate findings, specify the primary finding via deduplicatedWith.
8. CRITICAL: verifiedEvidenceRefs MUST be a SUBSET of the finding's evidenceRefs listed below. Do NOT invent new evidence refs.

EVIDENCE CLASSIFICATION:
- observed: conclusion directly proven by code, diff, test output, or verification record
- derived: conclusion deduced from multiple verified facts; must preserve derivation chain
- hypothesis: reasonable concern but insufficient evidence to prove real impact

DISPOSITION RULES:
- accepted: evidence is sufficient, finding stands at its current or lower impact level
- downgraded: evidence supports the concern but at a lower impact level
- needs_context: risk is reasonable but missing business, interface, or runtime context
- rejected: evidence is invalid, duplicate, irreproducible, or outside scope

IMPACT LEVELS (cannot upgrade):
- merge_blocking > material > advisory > needs_context

BEHAVIOR-REVIEW FINDINGS:
${brFindingsList}

TEST-REVIEW FINDINGS:
${trFindingsList}

OUTPUT FORMAT (JSON):
{
  "auditedFindings": [{
    "sourceFindingRef": "B001 or T001",
    "sourceStage": "behavior-review|test-review",
    "disposition": "accepted|downgraded|needs_context|rejected",
    "evidenceClass": "observed|derived|hypothesis",
    "effectiveCandidateImpact": "merge_blocking|material|advisory|needs_context|null",
    "rationale": "...",
    "verifiedEvidenceRefs": ["ONLY refs from the finding's evidenceRefs listed above"],
    "missingEvidence": ["..."],
    "missingContext": ["..."],
    "deduplicatedWith": "optional: B001 or T001"
  }],
  "summary": {
    "accepted": 0,
    "downgraded": 0,
    "needsContext": 0,
    "rejected": 0
  },
  "assumptions": ["..."]
}`;
}

const EVIDENCE_AUDIT_SCHEMA = {
  type: "object",
  properties: {
    auditedFindings: { type: "array" },
    summary: { type: "object" },
    assumptions: { type: "array" },
  },
  required: ["auditedFindings", "summary", "assumptions"],
};

async function runEvidenceAuditStage(ctx: {
  runId: string; runDir: string; cwd: string; adapter: ReviewStageAdapter;
  manifest: InputManifest; diffContent: string; changedFilesContent: string;
  gitState: { headCommit: string }; verificationLedgerHash?: string; stagesDir: string;
  inputManifestHash: string;
}): Promise<{ stageArtifactPath: string }> {
  const { runId, cwd, adapter, gitState, verificationLedgerHash, stagesDir, inputManifestHash } = ctx;
  const stage = "evidence-audit";

  // Prerequisites: all three prior stage artifacts must exist
  const changeMapPath = resolve(stagesDir, "change-map.json");
  if (!existsSync(changeMapPath)) {
    throw new StageError("change-map.json not found. Run change-map stage first.");
  }
  const behaviorReviewPath = resolve(stagesDir, "behavior-review.json");
  if (!existsSync(behaviorReviewPath)) {
    throw new StageError("behavior-review.json not found. Run behavior-review stage first.");
  }
  const testReviewPath = resolve(stagesDir, "test-review.json");
  if (!existsSync(testReviewPath)) {
    throw new StageError("test-review.json not found. Run test-review stage first.");
  }

  const changeMapContent = readFileSync(changeMapPath, "utf-8");
  const changeMapHash = sha256(changeMapContent);
  const behaviorReviewContent = readFileSync(behaviorReviewPath, "utf-8");
  const behaviorReviewHash = sha256(behaviorReviewContent);
  const testReviewContent = readFileSync(testReviewPath, "utf-8");
  const testReviewHash = sha256(testReviewContent);

  const behaviorReview = JSON.parse(behaviorReviewContent) as BehaviorReview;
  const testReview = JSON.parse(testReviewContent) as TestReview;

  const prompt = buildEvidenceAuditPrompt(behaviorReviewContent, testReviewContent, gitState.headCommit);

  let rawMessages: unknown;
  let structuredOutput: unknown;
  try {
    const result = await adapter.runStage({ stage, runDirectory: cwd, prompt, schema: EVIDENCE_AUDIT_SCHEMA });
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
  const forbiddenErrors = validateEvidenceAuditForbiddenFields(structuredOutput);
  if (forbiddenErrors.length > 0) {
    throw new StageError(`Invalid output: ${forbiddenErrors.join(", ")}`);
  }

  const evidenceAudit = structuredOutput as EvidenceAudit;

  // Validate audit rules
  const auditErrors = validateEvidenceAudit(evidenceAudit, behaviorReview, testReview);
  if (auditErrors.length > 0) {
    throw new StageError(`Invalid evidence audit: ${auditErrors.join(", ")}`);
  }

  const artifact: EvidenceAudit = {
    runId, stage: "evidence-audit", createdAt: new Date().toISOString(),
    sourceArtifacts: {
      inputManifestHash,
      changeMapHash,
      behaviorReviewHash,
      testReviewHash,
      verificationLedgerHash,
    },
    auditedFindings: evidenceAudit.auditedFindings,
    summary: evidenceAudit.summary,
    assumptions: evidenceAudit.assumptions,
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

const MAX_SOURCE_LINES_PER_FILE = 200;

function buildSourceContext(changedFiles: Array<{ path: string }>, headCommit: string): string {
  const sections: string[] = [];
  for (const file of changedFiles) {
    try {
      const content = getFileContentAtCommit(headCommit, file.path);
      const lines = content.split("\n");
      const truncated = lines.length > MAX_SOURCE_LINES_PER_FILE;
      const displayLines = truncated ? lines.slice(0, MAX_SOURCE_LINES_PER_FILE) : lines;
      const numbered = displayLines.map((line, i) => `${i + 1}: ${line}`).join("\n");
      const truncationNote = truncated ? `\n[... truncated: showing ${MAX_SOURCE_LINES_PER_FILE} of ${lines.length} lines]` : "";
      sections.push(`\n--- SOURCE: git:${headCommit}:${file.path} ---\n${numbered}${truncationNote}\n--- END SOURCE ---`);
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
  },
  required: ["changedModules", "behaviorChanges", "riskAreas", "reviewPriorities", "uncoveredContext", "assumptions"],
};
