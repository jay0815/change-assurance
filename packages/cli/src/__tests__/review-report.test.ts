import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reviewReport, ReportError } from "../review-report.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import * as core from "@change-assurance/core";

vi.mock("@change-assurance/core", async () => {
  const actual = await vi.importActual<typeof import("@change-assurance/core")>("@change-assurance/core");
  return {
    ...actual,
    getHeadCommit: vi.fn(),
    isWorkingTreeDirty: vi.fn(),
  };
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("reviewReport", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "change-assurance-report-test-"));
    process.chdir(tempDir);

    vi.mocked(core.getHeadCommit).mockReset();
    vi.mocked(core.getHeadCommit).mockReturnValue("abc123");
    vi.mocked(core.isWorkingTreeDirty).mockReset();
    vi.mocked(core.isWorkingTreeDirty).mockReturnValue(false);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createValidationResult(status: string, overrides?: any) {
    const runId = "test-report";
    const stagesDir = join(tempDir, ".change-assurance", "runs", runId, "stages");
    const ledgersDir = join(tempDir, ".change-assurance", "runs", runId, "ledgers");
    const validationDir = join(tempDir, ".change-assurance", "runs", runId, "validation");

    // Create artifacts first so we can compute hashes
    if (status === "valid") {
      mkdirSync(stagesDir, { recursive: true });
      mkdirSync(ledgersDir, { recursive: true });

      const synthesis = {
        runId, stage: "synthesis", createdAt: "2024-01-01T00:00:00.000Z",
        sourceArtifacts: { issueLedgerHash: "test", coverageLedgerHash: "test" },
        recommendation: "ready_to_merge",
        recommendationRationale: "All clear",
        issueGroups: [{
          title: "Null safety",
          issueIds: ["issue-br-F001"],
          summary: "One missing null check",
        }],
        verificationSummary: { passed: 1, failed: 0, skipped: 0, notRequired: 0, note: "build passed" },
        uncoveredSummary: [],
        assumptions: [],
      };
      const synthesisJson = JSON.stringify(synthesis, null, 2);
      writeFileSync(join(stagesDir, "synthesis.json"), synthesisJson);

      const issueLedger = {
        runId, createdAt: "2024-01-01T00:00:00.000Z",
        sourceArtifacts: { evidenceAuditHash: "", behaviorReviewHash: "", testReviewHash: "" },
        issues: [{
          id: "issue-br-F001", sourceFindingRef: "F001", sourceStage: "behavior-review",
          status: "accepted", evidenceClass: "observed", candidateImpact: "material",
          title: "Missing null check", summary: "Found missing null check",
          impact: "NPE risk", recommendation: "Add null guard",
          evidenceRefs: [], missingEvidence: [], missingContext: [],
        }],
        summary: { accepted: 1, downgraded: 0, needsContext: 0, deduplicated: 0 },
      };
      writeFileSync(join(ledgersDir, "issue-ledger.json"), JSON.stringify(issueLedger, null, 2));

      const coverageLedger = {
        runId, createdAt: "2024-01-01T00:00:00.000Z",
        sourceArtifacts: { changeMapHash: "", behaviorReviewHash: "", testReviewHash: "" },
        items: [{
          id: "cov-1", area: "auth", paths: [], status: "uncovered",
          sources: ["change-map"], evidenceRefs: [], reason: "Not reviewed",
        }],
        summary: { reviewed: 0, toolVerified: 0, uncovered: 1, needsContext: 0 },
      };
      writeFileSync(join(ledgersDir, "coverage-ledger.json"), JSON.stringify(coverageLedger, null, 2));
    }

    mkdirSync(validationDir, { recursive: true });

    // Compute correct hashes for sourceArtifacts
    const sourceArtifacts: Array<{ path: string; hash: string }> = [];
    if (status === "valid") {
      const synthesisPath = join(stagesDir, "synthesis.json");
      if (existsSync(synthesisPath)) {
        sourceArtifacts.push({ path: "stages/synthesis.json", hash: sha256(readFileSync(synthesisPath, "utf-8")) });
      }
    }

    const validationContent = JSON.stringify({
      runId,
      createdAt: "2024-01-01T00:00:00.000Z",
      status,
      finalDecision: status === "valid" ? "ready_to_merge" : null,
      sourceArtifacts,
      errors: status === "valid" ? [] : [{ code: "TEST_ERROR", message: "Test error" }],
      warnings: [],
      ...overrides,
    }, null, 2);

    writeFileSync(join(validationDir, "validation-result.json"), validationContent);

    return { runId };
  }

  it("should generate report from valid validation result", () => {
    const { runId } = createValidationResult("valid");
    const result = reviewReport({ runId });

    expect(result.reportMarkdownPath).toBeTruthy();
    expect(result.reportJsonPath).toBeTruthy();

    const mdContent = readFileSync(result.reportMarkdownPath, "utf-8");
    expect(mdContent).toContain("ready_to_merge");
    expect(mdContent).toContain("Null safety");

    const jsonContent = JSON.parse(readFileSync(result.reportJsonPath, "utf-8"));
    expect(jsonContent.status).toBe("valid");
    expect(jsonContent.finalDecision).toBe("ready_to_merge");
  });

  it("should generate diagnostic report for invalidated result", () => {
    const { runId } = createValidationResult("invalidated", {
      errors: [{ code: "HEAD_CHANGED", message: "HEAD changed" }],
    });
    const result = reviewReport({ runId });

    const mdContent = readFileSync(result.reportMarkdownPath, "utf-8");
    expect(mdContent).toContain("INVALIDATED");
    expect(mdContent).toContain("HEAD_CHANGED");

    const jsonContent = JSON.parse(readFileSync(result.reportJsonPath, "utf-8"));
    expect(jsonContent.status).toBe("invalidated");
    expect(jsonContent.finalDecision).toBeNull();
  });

  it("should generate diagnostic report for blocked result", () => {
    const { runId } = createValidationResult("blocked", {
      errors: [{ code: "MISSING_SYNTHESIS", message: "synthesis.json not found" }],
    });
    const result = reviewReport({ runId });

    const mdContent = readFileSync(result.reportMarkdownPath, "utf-8");
    expect(mdContent).toContain("BLOCKED");

    const jsonContent = JSON.parse(readFileSync(result.reportJsonPath, "utf-8"));
    expect(jsonContent.status).toBe("blocked");
    expect(jsonContent.finalDecision).toBeNull();
  });

  it("should fail when validation-result.json does not exist", () => {
    expect(() => reviewReport({ runId: "nonexistent" }))
      .toThrow(ReportError);
  });

  it("should include uncovered areas in report", () => {
    const { runId } = createValidationResult("valid");
    const result = reviewReport({ runId });

    const jsonContent = JSON.parse(readFileSync(result.reportJsonPath, "utf-8"));
    expect(jsonContent.uncoveredAreas).toHaveLength(1);
    expect(jsonContent.uncoveredAreas[0].area).toBe("auth");
  });

  it("should include issues grouped by impact in report", () => {
    const { runId } = createValidationResult("valid");
    const result = reviewReport({ runId });

    const jsonContent = JSON.parse(readFileSync(result.reportJsonPath, "utf-8"));
    expect(jsonContent.issues.material).toHaveLength(1);
    expect(jsonContent.issues.material[0].title).toBe("Missing null check");
  });

  it("should not show ready_to_merge for invalidated result", () => {
    const { runId } = createValidationResult("invalidated");
    const result = reviewReport({ runId });

    const mdContent = readFileSync(result.reportMarkdownPath, "utf-8");
    expect(mdContent).not.toContain("ready_to_merge");
  });
});
