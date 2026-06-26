import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reviewStage, StageError } from "../review-stage.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import * as core from "@change-assurance/core";

vi.mock("@change-assurance/core", async () => {
  const actual = await vi.importActual<typeof import("@change-assurance/core")>("@change-assurance/core");
  return {
    ...actual,
    getHeadCommit: vi.fn(),
    isWorkingTreeDirty: vi.fn(),
    getFileContentAtCommit: vi.fn(),
    fileExistsAtCommit: vi.fn(),
  };
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("reviewStage - synthesis", () => {
  let tempDir: string;
  let originalCwd: string;
  let mockGetHeadCommit: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "change-assurance-synthesis-test-"));
    process.chdir(tempDir);

    mockGetHeadCommit = vi.mocked(core.getHeadCommit);
    mockGetHeadCommit.mockReset();
    mockGetHeadCommit.mockReturnValue("abc123");
    vi.mocked(core.isWorkingTreeDirty).mockReset();
    vi.mocked(core.isWorkingTreeDirty).mockReturnValue(false);
    vi.mocked(core.getFileContentAtCommit).mockReset();
    vi.mocked(core.fileExistsAtCommit).mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createSynthesisFixture(opts?: {
    issues?: any[];
    coverageItems?: any[];
    verificationLedger?: any;
    issueSummary?: any;
    coverageSummary?: any;
  }) {
    const runId = "test-synthesis";
    const policy = { version: 1 };
    const changedFiles = [{ path: "src/index.ts", status: "modified", additions: 10, deletions: 5 }];
    const gitState = {
      baseRef: "main", headRef: "HEAD", baseCommit: "base123", headCommit: "abc123",
      branch: "main", isDirty: false, timestamp: "2024-01-01T00:00:00.000Z",
    };

    const policySnapshot = stringify(policy);
    const changedFilesJson = JSON.stringify(changedFiles, null, 2);
    const gitStateJson = JSON.stringify(gitState, null, 2);

    const manifest = {
      runId, baseRef: "main", headRef: "HEAD", createdAt: "2024-01-01T00:00:00.000Z",
      policySnapshotHash: sha256(policySnapshot),
      diffHash: sha256("diff content"),
      changedFilesHash: sha256(changedFilesJson),
      gitStateHash: sha256(gitStateJson),
    };

    const inputDir = join(tempDir, ".change-assurance", "runs", runId, "input");
    const stagesDir = join(tempDir, ".change-assurance", "runs", runId, "stages");
    const ledgersDir = join(tempDir, ".change-assurance", "runs", runId, "ledgers");
    const verificationDir = join(tempDir, ".change-assurance", "runs", runId, "verification");
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(stagesDir, { recursive: true });
    mkdirSync(ledgersDir, { recursive: true });

    writeFileSync(join(inputDir, "input-manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(inputDir, "diff.patch"), "diff content");
    writeFileSync(join(inputDir, "changed-files.json"), changedFilesJson);
    writeFileSync(join(inputDir, "git-state.json"), gitStateJson);
    writeFileSync(join(inputDir, "policy.snapshot.yaml"), policySnapshot);

    // Create prerequisite stage artifacts (empty, just need to exist)
    const changeMap = {
      runId, stage: "change-map", createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: { inputManifestHash: sha256(JSON.stringify(manifest, null, 2)), policySnapshotHash: sha256(policySnapshot) },
      changedModules: [], behaviorChanges: [], riskAreas: [],
      reviewPriorities: [], uncoveredContext: [], assumptions: [],
    };
    writeFileSync(join(stagesDir, "change-map.json"), JSON.stringify(changeMap, null, 2));

    const behaviorReview = {
      runId, stage: "behavior-review", createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: { inputManifestHash: "", changeMapHash: sha256(JSON.stringify(changeMap, null, 2)) },
      reviewedAreas: [], findings: [], uncoveredContext: [], assumptions: [],
    };
    writeFileSync(join(stagesDir, "behavior-review.json"), JSON.stringify(behaviorReview, null, 2));

    const testReview = {
      runId, stage: "test-review", createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: { inputManifestHash: "", changeMapHash: "", behaviorReviewHash: sha256(JSON.stringify(behaviorReview, null, 2)) },
      reviewedBehaviors: [], findings: [],
      verificationAssessment: { testCommandStatus: "unavailable", note: "" },
      uncoveredContext: [], assumptions: [],
    };
    writeFileSync(join(stagesDir, "test-review.json"), JSON.stringify(testReview, null, 2));

    const evidenceAudit = {
      runId, stage: "evidence-audit", createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: {
        inputManifestHash: "", changeMapHash: "",
        behaviorReviewHash: sha256(JSON.stringify(behaviorReview, null, 2)),
        testReviewHash: sha256(JSON.stringify(testReview, null, 2)),
      },
      auditedFindings: [], summary: { accepted: 0, downgraded: 0, needsContext: 0, rejected: 0 }, assumptions: [],
    };
    writeFileSync(join(stagesDir, "evidence-audit.json"), JSON.stringify(evidenceAudit, null, 2));

    // Create issue-ledger
    const issues = opts?.issues ?? [];
    const issueSummary = opts?.issueSummary ?? {
      accepted: issues.filter((i: any) => i.status === "accepted").length,
      downgraded: issues.filter((i: any) => i.status === "downgraded").length,
      needsContext: issues.filter((i: any) => i.status === "needs_context").length,
      deduplicated: 0,
    };
    const issueLedger = {
      runId, createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: { evidenceAuditHash: "", behaviorReviewHash: "", testReviewHash: "" },
      issues,
      summary: issueSummary,
    };
    writeFileSync(join(ledgersDir, "issue-ledger.json"), JSON.stringify(issueLedger, null, 2));

    // Create coverage-ledger
    const coverageItems = opts?.coverageItems ?? [];
    const coverageSummary = opts?.coverageSummary ?? {
      reviewed: coverageItems.filter((i: any) => i.status === "reviewed").length,
      toolVerified: coverageItems.filter((i: any) => i.status === "tool_verified").length,
      uncovered: coverageItems.filter((i: any) => i.status === "uncovered").length,
      needsContext: coverageItems.filter((i: any) => i.status === "needs_context").length,
    };
    const coverageLedger = {
      runId, createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: { changeMapHash: "", behaviorReviewHash: "", testReviewHash: "" },
      items: coverageItems,
      summary: coverageSummary,
    };
    writeFileSync(join(ledgersDir, "coverage-ledger.json"), JSON.stringify(coverageLedger, null, 2));

    // Create verification-ledger if provided
    if (opts?.verificationLedger) {
      mkdirSync(verificationDir, { recursive: true });
      writeFileSync(join(verificationDir, "verification-ledger.json"), JSON.stringify(opts.verificationLedger, null, 2));
    }

    return { runId, issueLedger, coverageLedger };
  }

  function createFakeAdapter(structuredOutput: unknown) {
    return {
      detectCapabilities: vi.fn().mockReturnValue({ available: true, supportsJsonOutput: true, supportsJsonSchema: true }),
      runStage: vi.fn().mockResolvedValue({ rawOutput: {}, structuredOutput }),
    };
  }

  it("should only reference issueIds that exist in issue-ledger", async () => {
    const { runId } = createSynthesisFixture({
      issues: [{
        id: "issue-br-F001", sourceFindingRef: "F001", sourceStage: "behavior-review",
        status: "accepted", evidenceClass: "observed", candidateImpact: "material",
        title: "Test issue", summary: "test", impact: "test", recommendation: "test",
        evidenceRefs: [], missingEvidence: [], missingContext: [],
      }],
    });

    const adapter = createFakeAdapter({
      recommendation: "ready_to_merge",
      recommendationRationale: "All clear",
      issueGroups: [{ title: "Group", issueIds: ["nonexistent-id"], summary: "test" }],
      verificationSummary: { passed: 0, failed: 0, skipped: 0, notRequired: 0, note: "" },
      uncoveredSummary: [],
      assumptions: [],
    });

    await expect(reviewStage({ runId, stage: "synthesis", adapter }))
      .rejects.toThrow(StageError);
  });

  it("should fail when synthesis adds new evidenceRef not in issue-ledger", async () => {
    const { runId } = createSynthesisFixture({
      issues: [{
        id: "issue-br-F001", sourceFindingRef: "F001", sourceStage: "behavior-review",
        status: "accepted", evidenceClass: "observed", candidateImpact: "material",
        title: "Test issue", summary: "test", impact: "test", recommendation: "test",
        evidenceRefs: ["git:abc123:src/index.ts#L1-L5"],
        missingEvidence: [], missingContext: [],
      }],
    });

    const adapter = createFakeAdapter({
      recommendation: "ready_to_merge",
      recommendationRationale: "All clear",
      issueGroups: [{
        title: "Group", issueIds: ["issue-br-F001"],
        summary: "test",
        // Synthesis tries to add its own evidence ref
        evidenceRefs: ["git:abc123:src/other.ts#L1-L10"],
      }],
      verificationSummary: { passed: 0, failed: 0, skipped: 0, notRequired: 0, note: "" },
      uncoveredSummary: [],
      assumptions: [],
    });

    await expect(reviewStage({ runId, stage: "synthesis", adapter }))
      .rejects.toThrow(StageError);
  });

  it("should fail when blocking candidate exists but recommendation is ready_to_merge", async () => {
    const { runId } = createSynthesisFixture({
      issues: [{
        id: "issue-br-F001", sourceFindingRef: "F001", sourceStage: "behavior-review",
        status: "accepted", evidenceClass: "observed", candidateImpact: "merge_blocking",
        title: "Blocking issue", summary: "test", impact: "test", recommendation: "test",
        evidenceRefs: [], missingEvidence: [], missingContext: [],
      }],
    });

    const adapter = createFakeAdapter({
      recommendation: "ready_to_merge",
      recommendationRationale: "Looks fine",
      issueGroups: [],
      verificationSummary: { passed: 0, failed: 0, skipped: 0, notRequired: 0, note: "" },
      uncoveredSummary: [],
      assumptions: [],
    });

    await expect(reviewStage({ runId, stage: "synthesis", adapter }))
      .rejects.toThrow(StageError);
  });

  it("should fail when verification failed but recommendation is ready_to_merge", async () => {
    const { runId } = createSynthesisFixture({
      verificationLedger: {
        runId: "test-synthesis", createdAt: "2024-01-01T00:00:00.000Z",
        runStatus: "completed", policySnapshotHash: "test",
        preconditionErrors: [],
        commands: [{ id: "test", argv: ["pnpm", "test"], required: true, status: "failed", selectionReason: "paths changed" }],
        summary: { passed: 0, failed: 1, skipped: 0, notRequired: 0 },
        workspaceChangedAfterVerify: false,
      },
    });

    const adapter = createFakeAdapter({
      recommendation: "ready_to_merge",
      recommendationRationale: "Looks fine",
      issueGroups: [],
      verificationSummary: { passed: 0, failed: 1, skipped: 0, notRequired: 0, note: "test failed" },
      uncoveredSummary: [],
      assumptions: [],
    });

    await expect(reviewStage({ runId, stage: "synthesis", adapter }))
      .rejects.toThrow(StageError);
  });

  it("should fail when ledger hash mismatch and not call adapter", async () => {
    const { runId } = createSynthesisFixture();
    // Tamper with issue-ledger after creation
    const ledgersDir = join(tempDir, ".change-assurance", "runs", runId, "ledgers");
    const tamperedLedger = { tampered: true };
    writeFileSync(join(ledgersDir, "issue-ledger.json"), JSON.stringify(tamperedLedger));

    const adapter = createFakeAdapter({
      recommendation: "ready_to_merge",
      recommendationRationale: "test",
      issueGroups: [],
      verificationSummary: { passed: 0, failed: 0, skipped: 0, notRequired: 0, note: "" },
      uncoveredSummary: [],
      assumptions: [],
    });

    await expect(reviewStage({ runId, stage: "synthesis", adapter }))
      .rejects.toThrow(StageError);

    expect(adapter.runStage).not.toHaveBeenCalled();
  });

  it("should properly summarize uncovered and needs_context items", async () => {
    const { runId } = createSynthesisFixture({
      coverageItems: [
        { id: "cov-1", area: "auth", paths: [], status: "uncovered", sources: ["change-map"], evidenceRefs: [], reason: "Not reviewed" },
        { id: "cov-2", area: "db", paths: [], status: "needs_context", sources: ["change-map"], evidenceRefs: [], reason: "Need schema info" },
      ],
    });

    const adapter = createFakeAdapter({
      recommendation: "insufficient_evidence",
      recommendationRationale: "Gaps exist",
      issueGroups: [],
      verificationSummary: { passed: 0, failed: 0, skipped: 0, notRequired: 0, note: "" },
      uncoveredSummary: [
        { coverageItemId: "cov-1", status: "uncovered", summary: "Auth not reviewed" },
        { coverageItemId: "cov-2", status: "needs_context", summary: "Need DB schema" },
      ],
      assumptions: [],
    });

    const result = await reviewStage({ runId, stage: "synthesis", adapter });
    const artifact = JSON.parse(readFileSync(result.stageArtifactPath, "utf-8"));

    expect(artifact.stage).toBe("synthesis");
    expect(artifact.uncoveredSummary).toHaveLength(2);
    expect(artifact.recommendation).toBe("insufficient_evidence");
  });

  it("should record truncated issues in assumptions", async () => {
    // Create many issues to trigger truncation
    const issues = Array.from({ length: 60 }, (_, i) => ({
      id: `issue-br-F${String(i).padStart(3, "0")}`,
      sourceFindingRef: `F${String(i).padStart(3, "0")}`,
      sourceStage: "behavior-review" as const,
      status: "accepted",
      evidenceClass: "observed",
      candidateImpact: "advisory",
      title: `Issue ${i}`,
      summary: "test",
      impact: "test",
      recommendation: "test",
      evidenceRefs: [],
      missingEvidence: [],
      missingContext: [],
    }));

    const { runId } = createSynthesisFixture({ issues });

    // Synthesis only references first 50 issues in groups
    const issueGroups = [{
      title: "All issues",
      issueIds: issues.slice(0, 50).map((i) => i.id),
      summary: "Grouped",
    }];

    const adapter = createFakeAdapter({
      recommendation: "not_ready_to_merge",
      recommendationRationale: "Too many issues",
      issueGroups,
      verificationSummary: { passed: 0, failed: 0, skipped: 0, notRequired: 0, note: "" },
      uncoveredSummary: [],
      assumptions: ["Truncated 10 low-priority advisory issues due to input capacity limits"],
    });

    const result = await reviewStage({ runId, stage: "synthesis", adapter });
    const artifact = JSON.parse(readFileSync(result.stageArtifactPath, "utf-8"));

    expect(artifact.assumptions).toEqual(
      expect.arrayContaining([expect.stringContaining("Truncated")])
    );
  });

  it("should write valid synthesis artifact on success", async () => {
    const { runId } = createSynthesisFixture({
      issues: [{
        id: "issue-br-F001", sourceFindingRef: "F001", sourceStage: "behavior-review",
        status: "accepted", evidenceClass: "observed", candidateImpact: "material",
        title: "Missing null check", summary: "Found missing null check",
        impact: "NPE risk", recommendation: "Add null guard",
        evidenceRefs: ["git:abc123:src/index.ts#L10-L15"],
        missingEvidence: [], missingContext: [],
      }],
      coverageItems: [
        { id: "cov-1", area: "core logic", paths: ["src/index.ts"], status: "reviewed", sources: ["behavior-review"], evidenceRefs: [], reason: "Reviewed" },
      ],
      verificationLedger: {
        runId: "test-synthesis", createdAt: "2024-01-01T00:00:00.000Z",
        runStatus: "completed", policySnapshotHash: "test",
        preconditionErrors: [],
        commands: [{ id: "build", argv: ["pnpm", "build"], required: true, status: "passed", selectionReason: "always" }],
        summary: { passed: 1, failed: 0, skipped: 0, notRequired: 0 },
        workspaceChangedAfterVerify: false,
      },
    });

    const adapter = createFakeAdapter({
      recommendation: "ready_to_merge",
      recommendationRationale: "Single material issue, all checks pass",
      issueGroups: [{
        title: "Null safety",
        issueIds: ["issue-br-F001"],
        summary: "One missing null check",
      }],
      verificationSummary: { passed: 1, failed: 0, skipped: 0, notRequired: 0, note: "build passed" },
      uncoveredSummary: [],
      assumptions: [],
    });

    const result = await reviewStage({ runId, stage: "synthesis", adapter });
    const artifact = JSON.parse(readFileSync(result.stageArtifactPath, "utf-8"));

    expect(artifact.stage).toBe("synthesis");
    expect(artifact.runId).toBe(runId);
    expect(artifact.recommendation).toBe("ready_to_merge");
    expect(artifact.recommendationRationale).toBe("Single material issue, all checks pass");
    expect(artifact.issueGroups).toHaveLength(1);
    expect(artifact.issueGroups[0].issueIds).toEqual(["issue-br-F001"]);
    expect(artifact.verificationSummary.passed).toBe(1);
    expect(artifact.sourceArtifacts.issueLedgerHash).toBeTruthy();
    expect(artifact.sourceArtifacts.coverageLedgerHash).toBeTruthy();
    expect(artifact.sourceArtifacts.verificationLedgerHash).toBeTruthy();
  });
});
