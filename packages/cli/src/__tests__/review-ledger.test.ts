import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateLedgers, LedgerError } from "../review-ledger.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { stringify } from "yaml";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("generateLedgers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "change-assurance-ledger-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createLedgerFixture(opts?: {
    evidenceAuditFindings?: any[];
    verificationLedger?: any;
    behaviorReviewFindings?: any[];
    testReviewFindings?: any[];
    reviewPriorities?: any[];
  }) {
    const runId = "test-ledger";
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
      diffHash: sha256("diff"),
      changedFilesHash: sha256(changedFilesJson),
      gitStateHash: sha256(gitStateJson),
    };

    const inputDir = join(tempDir, ".change-assurance", "runs", runId, "input");
    const stagesDir = join(tempDir, ".change-assurance", "runs", runId, "stages");
    const verificationDir = join(tempDir, ".change-assurance", "runs", runId, "verification");
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(stagesDir, { recursive: true });

    writeFileSync(join(inputDir, "input-manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(inputDir, "diff.patch"), "diff");
    writeFileSync(join(inputDir, "changed-files.json"), changedFilesJson);
    writeFileSync(join(inputDir, "git-state.json"), gitStateJson);
    writeFileSync(join(inputDir, "policy.snapshot.yaml"), policySnapshot);

    const changeMap = {
      runId,
      stage: "change-map",
      createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: {
        inputManifestHash: sha256(policySnapshot),
        policySnapshotHash: sha256(policySnapshot),
      },
      changedModules: [{ path: "src/index.ts", role: "entry", changeSummary: "modified" }],
      behaviorChanges: [],
      riskAreas: [],
      reviewPriorities: opts?.reviewPriorities ?? [
        { priority: "high", area: "entry logic", reason: "core change" },
      ],
      uncoveredContext: [],
      assumptions: [],
    };
    const changeMapJsonStr = JSON.stringify(changeMap, null, 2);
    writeFileSync(join(stagesDir, "change-map.json"), changeMapJsonStr);

    const brFindings = opts?.behaviorReviewFindings ?? [
      {
        id: "B001",
        title: "Missing null check",
        type: "failure_path",
        candidateImpact: "material",
        trigger: "null",
        observedBehavior: "throws",
        impact: "crash",
        recommendation: "add check",
        evidenceRefs: ["ref1"],
        confidence: "high",
      },
    ];
    const behaviorReview = {
      runId,
      stage: "behavior-review",
      createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: {
        inputManifestHash: sha256(policySnapshot),
        changeMapHash: sha256(changeMapJsonStr),
      },
      reviewedAreas: [
        {
          area: "entry logic",
          paths: ["src/index.ts"],
          focus: "null check",
          evidenceRefs: ["ref1"],
        },
      ],
      findings: brFindings,
      uncoveredContext: [],
      assumptions: [],
    };
    writeFileSync(join(stagesDir, "behavior-review.json"), JSON.stringify(behaviorReview, null, 2));

    const trFindings = opts?.testReviewFindings ?? [
      {
        id: "T001",
        title: "Missing test",
        type: "missing_test",
        candidateImpact: "material",
        behavior: "null check",
        observedTestCoverage: "none",
        impact: "untested",
        recommendation: "add test",
        evidenceRefs: ["ref1"],
        confidence: "high",
      },
    ];
    const behaviorReviewJsonStr = JSON.stringify(behaviorReview, null, 2);
    const testReview = {
      runId,
      stage: "test-review",
      createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: {
        inputManifestHash: sha256(policySnapshot),
        changeMapHash: sha256(changeMapJsonStr),
        behaviorReviewHash: sha256(behaviorReviewJsonStr),
      },
      reviewedBehaviors: [
        {
          behavior: "null check",
          implementationEvidenceRefs: ["ref1"],
          testEvidenceRefs: [],
          assessment: "not_covered",
          rationale: "no test",
        },
      ],
      findings: trFindings,
      verificationAssessment: { testCommandStatus: "unavailable", note: "no ledger" },
      uncoveredContext: [],
      assumptions: [],
    };
    const testReviewJsonStr = JSON.stringify(testReview, null, 2);
    writeFileSync(join(stagesDir, "test-review.json"), testReviewJsonStr);

    const auditFindings = opts?.evidenceAuditFindings ?? [
      {
        sourceFindingRef: "B001",
        sourceStage: "behavior-review",
        disposition: "accepted",
        evidenceClass: "observed",
        effectiveCandidateImpact: "material",
        rationale: "verified",
        verifiedEvidenceRefs: ["ref1"],
        missingEvidence: [],
        missingContext: [],
      },
      {
        sourceFindingRef: "T001",
        sourceStage: "test-review",
        disposition: "accepted",
        evidenceClass: "observed",
        effectiveCandidateImpact: "material",
        rationale: "verified",
        verifiedEvidenceRefs: ["ref1"],
        missingEvidence: [],
        missingContext: [],
        deduplicatedWith: "B001",
      },
    ];
    const evidenceAudit = {
      runId,
      stage: "evidence-audit",
      createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: {
        inputManifestHash: sha256(policySnapshot),
        changeMapHash: sha256(changeMapJsonStr),
        behaviorReviewHash: sha256(behaviorReviewJsonStr),
        testReviewHash: sha256(testReviewJsonStr),
      },
      auditedFindings: auditFindings,
      summary: { accepted: 2, downgraded: 0, needsContext: 0, rejected: 0 },
      assumptions: [],
    };
    writeFileSync(join(stagesDir, "evidence-audit.json"), JSON.stringify(evidenceAudit, null, 2));

    if (opts?.verificationLedger) {
      mkdirSync(verificationDir, { recursive: true });
      writeFileSync(
        join(verificationDir, "verification-ledger.json"),
        JSON.stringify(opts.verificationLedger, null, 2),
      );
    }

    return { runId };
  }

  it("should archive accepted finding as issue", () => {
    const { runId } = createLedgerFixture({
      evidenceAuditFindings: [
        { sourceFindingRef: "B001", sourceStage: "behavior-review", disposition: "accepted", evidenceClass: "observed", effectiveCandidateImpact: "material", rationale: "verified", verifiedEvidenceRefs: ["ref1"], missingEvidence: [], missingContext: [] },
      ],
    });
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      const result = generateLedgers({ runId });
      const issueLedger = JSON.parse(readFileSync(result.issueLedgerPath, "utf-8"));
      expect(issueLedger.issues).toHaveLength(1);
      expect(issueLedger.issues[0].id).toBe("issue-behavior-review-B001");
      expect(issueLedger.issues[0].status).toBe("accepted");
    } finally {
      process.chdir(cwd);
    }
  });

  it("should not include rejected finding in issue ledger", () => {
    const { runId } = createLedgerFixture({
      evidenceAuditFindings: [
        {
          sourceFindingRef: "B001",
          sourceStage: "behavior-review",
          disposition: "rejected",
          evidenceClass: "hypothesis",
          effectiveCandidateImpact: null,
          rationale: "insufficient",
          verifiedEvidenceRefs: [],
          missingEvidence: ["proof"],
          missingContext: [],
        },
      ],
    });
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      const result = generateLedgers({ runId });
      const issueLedger = JSON.parse(readFileSync(result.issueLedgerPath, "utf-8"));
      expect(issueLedger.issues).toHaveLength(0);
      expect(issueLedger.summary.accepted).toBe(0);
    } finally {
      process.chdir(cwd);
    }
  });

  it("should not upgrade downgraded finding impact", () => {
    const { runId } = createLedgerFixture({
      evidenceAuditFindings: [
        {
          sourceFindingRef: "B001",
          sourceStage: "behavior-review",
          disposition: "downgraded",
          evidenceClass: "derived",
          effectiveCandidateImpact: "advisory",
          rationale: "less severe",
          verifiedEvidenceRefs: ["ref1"],
          missingEvidence: [],
          missingContext: [],
        },
      ],
    });
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      const result = generateLedgers({ runId });
      const issueLedger = JSON.parse(readFileSync(result.issueLedgerPath, "utf-8"));
      expect(issueLedger.issues).toHaveLength(1);
      expect(issueLedger.issues[0].candidateImpact).toBe("advisory");
      expect(issueLedger.issues[0].status).toBe("downgraded");
    } finally {
      process.chdir(cwd);
    }
  });

  it("should deduplicate findings within same stage but keep cross-stage findings", () => {
    const { runId } = createLedgerFixture();
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      const result = generateLedgers({ runId });
      const issueLedger = JSON.parse(readFileSync(result.issueLedgerPath, "utf-8"));
      // T001 (test-review) deduplicatedWith B001 (behavior-review) is cross-stage,
      // so both are kept as separate issues
      expect(issueLedger.issues).toHaveLength(2);
      expect(issueLedger.issues[0].sourceFindingRef).toBe("B001");
      expect(issueLedger.issues[1].sourceFindingRef).toBe("T001");
      expect(issueLedger.summary.deduplicated).toBe(0);
    } finally {
      process.chdir(cwd);
    }
  });

  it("should use verifiedEvidenceRefs from audit, not source finding refs", () => {
    const { runId } = createLedgerFixture({
      evidenceAuditFindings: [
        {
          sourceFindingRef: "B001",
          sourceStage: "behavior-review",
          disposition: "accepted",
          evidenceClass: "observed",
          effectiveCandidateImpact: "material",
          rationale: "verified",
          verifiedEvidenceRefs: ["ref1"],
          missingEvidence: [],
          missingContext: [],
        },
      ],
    });
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      const result = generateLedgers({ runId });
      const issueLedger = JSON.parse(readFileSync(result.issueLedgerPath, "utf-8"));
      // Issue's evidenceRefs must come from audit's verifiedEvidenceRefs
      expect(issueLedger.issues[0].evidenceRefs).toEqual(["ref1"]);
    } finally {
      process.chdir(cwd);
    }
  });

  it("should archive behavior-review reviewed area as reviewed", () => {
    const { runId } = createLedgerFixture();
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      const result = generateLedgers({ runId });
      const coverageLedger = JSON.parse(readFileSync(result.coverageLedgerPath, "utf-8"));
      const reviewed = coverageLedger.items.filter((i: any) => i.status === "reviewed");
      expect(reviewed.length).toBeGreaterThanOrEqual(1);
      expect(reviewed[0].sources).toContain("behavior-review");
    } finally {
      process.chdir(cwd);
    }
  });

  it("should archive passed verification command as tool_verified, not reviewed", () => {
    const { runId } = createLedgerFixture({
      verificationLedger: {
        runId: "test-ledger",
        createdAt: "2024-01-01T00:00:00.000Z",
        runStatus: "completed",
        policySnapshotHash: "test",
        preconditionErrors: [],
        commands: [{ id: "test", argv: ["pnpm", "test"], required: true, status: "passed" }],
        summary: { passed: 1, failed: 0, skipped: 0, notRequired: 0 },
        workspaceChangedAfterVerify: false,
      },
    });
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      const result = generateLedgers({ runId });
      const coverageLedger = JSON.parse(readFileSync(result.coverageLedgerPath, "utf-8"));
      const toolVerified = coverageLedger.items.filter((i: any) => i.status === "tool_verified");
      expect(toolVerified.length).toBeGreaterThanOrEqual(1);
      expect(toolVerified[0].sources).toContain("verification");
      // tool_verified should NOT be in sources as behavior-review
      expect(toolVerified[0].sources).not.toContain("behavior-review");
    } finally {
      process.chdir(cwd);
    }
  });

  it("should mark high priority area not covered by later stages as uncovered", () => {
    const { runId } = createLedgerFixture({
      reviewPriorities: [
        { priority: "high", area: "uncovered area", reason: "important" },
        { priority: "low", area: "low priority", reason: "minor" },
      ],
      behaviorReviewFindings: [],
      testReviewFindings: [],
      evidenceAuditFindings: [],
    });
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      const result = generateLedgers({ runId });
      const coverageLedger = JSON.parse(readFileSync(result.coverageLedgerPath, "utf-8"));
      const uncovered = coverageLedger.items.filter((i: any) => i.status === "uncovered");
      expect(uncovered.length).toBeGreaterThanOrEqual(1);
      expect(uncovered.some((u: any) => u.area === "uncovered area")).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it("should mark needs_context when evidence audit has missing context", () => {
    const { runId } = createLedgerFixture({
      evidenceAuditFindings: [
        {
          sourceFindingRef: "B001",
          sourceStage: "behavior-review",
          disposition: "needs_context",
          evidenceClass: "hypothesis",
          effectiveCandidateImpact: "needs_context",
          rationale: "missing info",
          verifiedEvidenceRefs: ["ref1"],
          missingEvidence: [],
          missingContext: ["runtime behavior"],
        },
      ],
    });
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      const result = generateLedgers({ runId });
      const issueLedger = JSON.parse(readFileSync(result.issueLedgerPath, "utf-8"));
      expect(issueLedger.issues[0].status).toBe("needs_context");
      expect(issueLedger.issues[0].missingContext).toContain("runtime behavior");
    } finally {
      process.chdir(cwd);
    }
  });

  it("should fail when artifact hash mismatch", () => {
    const { runId } = createLedgerFixture();
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      // Tamper with behavior-review.json after audit was created
      const brPath = join(
        tempDir,
        ".change-assurance",
        "runs",
        runId,
        "stages",
        "behavior-review.json",
      );
      writeFileSync(brPath, JSON.stringify({ tampered: true }));

      expect(() => generateLedgers({ runId })).toThrow(LedgerError);
    } finally {
      process.chdir(cwd);
    }
  });
});
