import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reviewValidate } from "../review-validate.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import * as core from "@change-assurance/core";
import { execFileSync } from "node:child_process";

vi.mock("@change-assurance/core", async () => {
  const actual =
    await vi.importActual<typeof import("@change-assurance/core")>("@change-assurance/core");
  return {
    ...actual,
    getHeadCommit: vi.fn(),
    isWorkingTreeDirty: vi.fn(),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("reviewValidate", () => {
  let tempDir: string;
  let originalCwd: string;
  let mockGetHeadCommit: ReturnType<typeof vi.fn>;
  let mockIsWorkingTreeDirty: ReturnType<typeof vi.fn>;
  let mockExecFileSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "change-assurance-validate-test-"));
    process.chdir(tempDir);

    mockGetHeadCommit = vi.mocked(core.getHeadCommit);
    mockIsWorkingTreeDirty = vi.mocked(core.isWorkingTreeDirty);
    mockExecFileSync = vi.mocked(execFileSync);
    mockGetHeadCommit.mockReset();
    mockIsWorkingTreeDirty.mockReset();
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createFullChainFixture(opts?: {
    tamperHash?: (path: string, content: string) => string;
    skipSynthesis?: boolean;
    skipLedgers?: boolean;
    blockingIssue?: boolean;
    failedVerification?: boolean;
    dirtyWorkspace?: boolean;
    headChanged?: boolean;
    synthesisRecommendation?: string;
  }) {
    const runId = "test-validate";
    const headCommit = opts?.headChanged ? "different-head" : "abc123";
    mockGetHeadCommit.mockReturnValue(headCommit);
    mockIsWorkingTreeDirty.mockReturnValue(opts?.dirtyWorkspace ?? false);

    const policy = { version: 1 };
    const changedFiles = [
      { path: "src/index.ts", status: "modified", additions: 10, deletions: 5 },
    ];
    const gitState = {
      baseRef: "main",
      headRef: "HEAD",
      baseCommit: "base123",
      headCommit: "abc123",
      branch: "main",
      isDirty: false,
      timestamp: "2024-01-01T00:00:00.000Z",
    };

    const policySnapshot = stringify(policy);
    const changedFilesJson = JSON.stringify(changedFiles, null, 2);
    const gitStateJson = JSON.stringify(gitState, null, 2);

    const manifest = {
      runId,
      baseRef: "main",
      headRef: "HEAD",
      createdAt: "2024-01-01T00:00:00.000Z",
      policySnapshotHash: sha256(policySnapshot),
      diffHash: sha256("diff content"),
      changedFilesHash: sha256(changedFilesJson),
      gitStateHash: sha256(gitStateJson),
    };
    const manifestJson = JSON.stringify(manifest, null, 2);

    const inputDir = join(tempDir, ".change-assurance", "runs", runId, "input");
    const stagesDir = join(tempDir, ".change-assurance", "runs", runId, "stages");
    const ledgersDir = join(tempDir, ".change-assurance", "runs", runId, "ledgers");
    const verificationDir = join(tempDir, ".change-assurance", "runs", runId, "verification");
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(stagesDir, { recursive: true });
    if (!opts?.skipLedgers) mkdirSync(ledgersDir, { recursive: true });

    // Write input artifacts
    writeFileSync(join(inputDir, "input-manifest.json"), manifestJson);
    writeFileSync(join(inputDir, "diff.patch"), "diff content");
    writeFileSync(join(inputDir, "changed-files.json"), changedFilesJson);
    writeFileSync(join(inputDir, "git-state.json"), gitStateJson);
    writeFileSync(join(inputDir, "policy.snapshot.yaml"), policySnapshot);

    // Stage artifacts
    const changeMap = {
      runId,
      stage: "change-map",
      createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: {
        inputManifestHash: sha256(manifestJson),
        policySnapshotHash: sha256(policySnapshot),
      },
      changedModules: [],
      behaviorChanges: [],
      riskAreas: [],
      reviewPriorities: [],
      uncoveredContext: [],
      assumptions: [],
    };
    const changeMapJson = JSON.stringify(changeMap, null, 2);
    writeFileSync(join(stagesDir, "change-map.json"), changeMapJson);

    const behaviorReview = {
      runId,
      stage: "behavior-review",
      createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: { inputManifestHash: "", changeMapHash: sha256(changeMapJson) },
      reviewedAreas: [],
      findings: [],
      uncoveredContext: [],
      assumptions: [],
    };
    const behaviorReviewJson = JSON.stringify(behaviorReview, null, 2);
    writeFileSync(join(stagesDir, "behavior-review.json"), behaviorReviewJson);

    const testReview = {
      runId,
      stage: "test-review",
      createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: {
        inputManifestHash: "",
        changeMapHash: "",
        behaviorReviewHash: sha256(behaviorReviewJson),
      },
      reviewedBehaviors: [],
      findings: [],
      verificationAssessment: { testCommandStatus: "unavailable", note: "" },
      uncoveredContext: [],
      assumptions: [],
    };
    const testReviewJson = JSON.stringify(testReview, null, 2);
    writeFileSync(join(stagesDir, "test-review.json"), testReviewJson);

    const evidenceAudit = {
      runId,
      stage: "evidence-audit",
      createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: {
        inputManifestHash: "",
        changeMapHash: "",
        behaviorReviewHash: sha256(behaviorReviewJson),
        testReviewHash: sha256(testReviewJson),
      },
      auditedFindings: [],
      summary: { accepted: 0, downgraded: 0, needsContext: 0, rejected: 0 },
      assumptions: [],
    };
    const evidenceAuditJson = JSON.stringify(evidenceAudit, null, 2);
    writeFileSync(join(stagesDir, "evidence-audit.json"), evidenceAuditJson);

    // Verification ledger
    const verificationLedger = {
      runId,
      createdAt: "2024-01-01T00:00:00.000Z",
      runStatus: "completed",
      policySnapshotHash: sha256(policySnapshot),
      preconditionErrors: [],
      commands: [
        {
          id: opts?.failedVerification ? "test-fail" : "build",
          argv: opts?.failedVerification ? ["pnpm", "test"] : ["pnpm", "build"],
          required: true,
          status: opts?.failedVerification ? "failed" : "passed",
          selectionReason: "always",
        },
      ],
      summary: {
        passed: opts?.failedVerification ? 0 : 1,
        failed: opts?.failedVerification ? 1 : 0,
        skipped: 0,
        notRequired: 0,
      },
      workspaceChangedAfterVerify: false,
    };
    const verificationLedgerJson = JSON.stringify(verificationLedger, null, 2);
    mkdirSync(verificationDir, { recursive: true });
    writeFileSync(join(verificationDir, "verification-ledger.json"), verificationLedgerJson);

    if (!opts?.skipLedgers) {
      // Issue ledger
      const issues = opts?.blockingIssue
        ? [
            {
              id: "issue-br-F001",
              sourceFindingRef: "F001",
              sourceStage: "behavior-review",
              status: "accepted",
              evidenceClass: "observed",
              candidateImpact: "merge_blocking",
              title: "Blocking issue",
              summary: "test",
              impact: "test",
              recommendation: "test",
              evidenceRefs: [],
              missingEvidence: [],
              missingContext: [],
            },
          ]
        : [];
      const issueLedger = {
        runId,
        createdAt: "2024-01-01T00:00:00.000Z",
        sourceArtifacts: {
          evidenceAuditHash: sha256(evidenceAuditJson),
          behaviorReviewHash: sha256(behaviorReviewJson),
          testReviewHash: sha256(testReviewJson),
        },
        issues,
        summary: {
          accepted: issues.length,
          downgraded: 0,
          needsContext: 0,
          deduplicated: 0,
        },
      };
      const issueLedgerJson = JSON.stringify(issueLedger, null, 2);
      writeFileSync(join(ledgersDir, "issue-ledger.json"), issueLedgerJson);

      // Coverage ledger
      const coverageLedger = {
        runId,
        createdAt: "2024-01-01T00:00:00.000Z",
        sourceArtifacts: {
          changeMapHash: sha256(changeMapJson),
          behaviorReviewHash: sha256(behaviorReviewJson),
          testReviewHash: sha256(testReviewJson),
          verificationLedgerHash: sha256(verificationLedgerJson),
        },
        items: [],
        summary: { reviewed: 0, toolVerified: 0, uncovered: 0, needsContext: 0 },
      };
      const coverageLedgerJson = JSON.stringify(coverageLedger, null, 2);
      writeFileSync(join(ledgersDir, "coverage-ledger.json"), coverageLedgerJson);

      if (!opts?.skipSynthesis) {
        const synthesis = {
          runId,
          stage: "synthesis",
          createdAt: "2024-01-01T00:00:00.000Z",
          sourceArtifacts: {
            issueLedgerHash: sha256(issueLedgerJson),
            coverageLedgerHash: sha256(coverageLedgerJson),
            verificationLedgerHash: sha256(verificationLedgerJson),
          },
          recommendation:
            opts?.synthesisRecommendation ??
            (opts?.blockingIssue ? "not_ready_to_merge" : "ready_to_merge"),
          recommendationRationale: "test",
          issueGroups: [],
          verificationSummary: {
            passed: opts?.failedVerification ? 0 : 1,
            failed: opts?.failedVerification ? 1 : 0,
            skipped: 0,
            notRequired: 0,
            note: "",
          },
          uncoveredSummary: [],
          assumptions: [],
        };
        writeFileSync(join(stagesDir, "synthesis.json"), JSON.stringify(synthesis, null, 2));
      }
    }

    return { runId };
  }

  it("should return valid status for complete consistent artifact chain", () => {
    const { runId } = createFullChainFixture();
    const result = reviewValidate({ runId });

    expect(result.status).toBe("valid");
    expect(result.finalDecision).toBe("ready_to_merge");
    expect(result.errors).toHaveLength(0);
  });

  it("should return invalidated when input artifact hash is tampered", () => {
    const { runId } = createFullChainFixture();
    // Tamper with diff.patch
    const diffPath = join(tempDir, ".change-assurance", "runs", runId, "input", "diff.patch");
    writeFileSync(diffPath, "tampered diff");

    const result = reviewValidate({ runId });

    expect(result.status).toBe("invalidated");
    expect(result.finalDecision).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("should return invalidated when stage is re-run but ledger not rebuilt", () => {
    const { runId } = createFullChainFixture();
    // Re-write behavior-review.json (simulating re-run)
    const stagesDir = join(tempDir, ".change-assurance", "runs", runId, "stages");
    const newBehaviorReview = {
      runId,
      stage: "behavior-review",
      createdAt: "2024-01-02T00:00:00.000Z",
      sourceArtifacts: { inputManifestHash: "", changeMapHash: "" },
      reviewedAreas: [{ area: "new", paths: [], focus: "test", evidenceRefs: [] }],
      findings: [],
      uncoveredContext: [],
      assumptions: [],
    };
    writeFileSync(
      join(stagesDir, "behavior-review.json"),
      JSON.stringify(newBehaviorReview, null, 2),
    );

    const result = reviewValidate({ runId });

    expect(result.status).toBe("invalidated");
    expect(result.errors.some((e) => e.code === "LEDGER_HASH_MISMATCH")).toBe(true);
  });

  it("should return invalidated when ledger rebuilt but synthesis not re-run", () => {
    const { runId } = createFullChainFixture();
    // Re-write issue-ledger.json (simulating ledger rebuild)
    const ledgersDir = join(tempDir, ".change-assurance", "runs", runId, "ledgers");
    const newIssueLedger = {
      runId,
      createdAt: "2024-01-02T00:00:00.000Z",
      sourceArtifacts: { evidenceAuditHash: "", behaviorReviewHash: "", testReviewHash: "" },
      issues: [],
      summary: { accepted: 0, downgraded: 0, needsContext: 0, deduplicated: 0 },
    };
    writeFileSync(join(ledgersDir, "issue-ledger.json"), JSON.stringify(newIssueLedger, null, 2));

    const result = reviewValidate({ runId });

    expect(result.status).toBe("invalidated");
    expect(result.errors.some((e) => e.code === "SYNTHESIS_HASH_MISMATCH")).toBe(true);
  });

  it("should return invalidated when HEAD changed", () => {
    const { runId } = createFullChainFixture({ headChanged: true });
    const result = reviewValidate({ runId });

    expect(result.status).toBe("invalidated");
    expect(result.errors.some((e) => e.code === "HEAD_CHANGED")).toBe(true);
  });

  it("should return invalidated when workspace is dirty", () => {
    const { runId } = createFullChainFixture({ dirtyWorkspace: true });
    // Mock git status to show changes outside .change-assurance/
    mockExecFileSync.mockReturnValue(" M src/index.ts\n");

    const result = reviewValidate({ runId });

    expect(result.status).toBe("invalidated");
    expect(result.errors.some((e) => e.code === "WORKSPACE_DIRTY")).toBe(true);
  });

  it("should not report workspace dirty when only .change-assurance/ changed", () => {
    const { runId } = createFullChainFixture({ dirtyWorkspace: true });
    // Mock git status to show only .change-assurance/ changes
    mockExecFileSync.mockReturnValue(
      " M .change-assurance/runs/test-validate/stages/synthesis.json\n",
    );

    const result = reviewValidate({ runId });

    expect(result.errors.some((e) => e.code === "WORKSPACE_DIRTY")).toBe(false);
  });

  it("should return blocked when synthesis is missing", () => {
    const { runId } = createFullChainFixture({ skipSynthesis: true });
    const result = reviewValidate({ runId });

    expect(result.status).toBe("blocked");
    expect(result.errors.some((e) => e.code === "MISSING_SYNTHESIS")).toBe(true);
  });

  it("should return blocked when ledgers are missing", () => {
    const { runId } = createFullChainFixture({ skipLedgers: true });
    const result = reviewValidate({ runId });

    expect(result.status).toBe("blocked");
    expect(result.finalDecision).toBeNull();
    expect(result.errors.some((e) => e.code === "MISSING_LEDGER")).toBe(true);
  });

  it("should return invalidated when blocking issue exists but synthesis says ready_to_merge", () => {
    const { runId } = createFullChainFixture({
      blockingIssue: true,
      synthesisRecommendation: "ready_to_merge",
    });
    const result = reviewValidate({ runId });

    expect(result.status).toBe("invalidated");
    expect(result.errors.some((e) => e.code === "DECISION_CONFLICT")).toBe(true);
  });

  it("should return invalidated when verification failed but synthesis says ready_to_merge", () => {
    const { runId } = createFullChainFixture({
      failedVerification: true,
      synthesisRecommendation: "ready_to_merge",
    });
    const result = reviewValidate({ runId });

    expect(result.status).toBe("invalidated");
    expect(result.errors.some((e) => e.code === "DECISION_CONFLICT")).toBe(true);
  });
});
