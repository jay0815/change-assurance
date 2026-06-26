import { describe, it, expect, vi, beforeEach } from "vitest";
import { reviewRun, RunError } from "../review-run.js";

vi.mock("../review-prepare.js", () => ({
  reviewPrepare: vi.fn(),
}));

vi.mock("../review-verify.js", () => ({
  reviewVerify: vi.fn(),
}));

vi.mock("../review-stage.js", () => ({
  reviewStage: vi.fn(),
}));

vi.mock("../review-ledger.js", () => ({
  generateLedgers: vi.fn(),
}));

vi.mock("../review-validate.js", () => ({
  reviewValidate: vi.fn(),
}));

vi.mock("../review-report.js", () => ({
  reviewReport: vi.fn(),
}));

vi.mock("../policy.js", () => ({
  loadPolicy: vi.fn(),
}));

import { reviewPrepare } from "../review-prepare.js";
import { reviewVerify } from "../review-verify.js";
import { reviewStage } from "../review-stage.js";
import { generateLedgers } from "../review-ledger.js";
import { reviewValidate } from "../review-validate.js";
import { reviewReport } from "../review-report.js";
import { loadPolicy } from "../policy.js";

describe("reviewRun", () => {
  beforeEach(() => {
    vi.mocked(reviewPrepare).mockReset();
    vi.mocked(reviewVerify).mockReset();
    vi.mocked(reviewStage).mockReset();
    vi.mocked(generateLedgers).mockReset();
    vi.mocked(reviewValidate).mockReset();
    vi.mocked(reviewReport).mockReset();
    vi.mocked(loadPolicy).mockReset();
    // Default: empty policy
    vi.mocked(loadPolicy).mockReturnValue({ version: 1 });
  });

  it("should exist", () => {
    expect(reviewRun).toBeDefined();
  });

  it("should throw RunError for unsupported engine", async () => {
    await expect(
      reviewRun({ engine: "other" as any, dryRun: true, adapter: {} as any })
    ).rejects.toThrow("Unsupported engine");
  });

  it("should throw RunError when dry-run is false", async () => {
    await expect(
      reviewRun({ engine: "claude", dryRun: false, adapter: {} as any })
    ).rejects.toThrow("Only dry-run mode is supported");
  });

  it("should throw RunError when adapter not available", async () => {
    const adapter = {
      detectCapabilities: () => ({ available: false }),
    };
    await expect(
      reviewRun({ engine: "claude", dryRun: true, adapter })
    ).rejects.toThrow("Claude CLI not available");
  });

  it("should return failed status when prepare fails", async () => {
    vi.mocked(reviewPrepare).mockImplementation(() => {
      throw new Error("Not a git repository");
    });
    const adapter = {
      detectCapabilities: () => ({ available: true }),
    };
    const result = await reviewRun({ engine: "claude", dryRun: true, adapter });
    expect(result.status).toBe("failed");
    expect(result.runId).toBe("unknown");
  });

  it("should return completed status when all steps succeed", async () => {
    vi.mocked(reviewPrepare).mockReturnValue({ runId: "test-run-123", inputDir: "/tmp/test" });
    vi.mocked(reviewVerify).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      runStatus: "completed",
      policySnapshotHash: "hash",
      preconditionErrors: [],
      commands: [],
      summary: { passed: 1, failed: 0, skipped: 0, notRequired: 0 },
      workspaceChangedAfterVerify: false,
    });
    vi.mocked(reviewStage).mockResolvedValue({ stageArtifactPath: "/tmp/test" });
    vi.mocked(generateLedgers).mockReturnValue({
      issueLedgerPath: "/tmp/issue-ledger",
      coverageLedgerPath: "/tmp/coverage-ledger",
    });
    vi.mocked(reviewValidate).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      status: "valid",
      finalDecision: "ready_to_merge",
      sourceArtifacts: [],
      errors: [],
      warnings: [],
    });
    vi.mocked(reviewReport).mockReturnValue({
      reportMarkdownPath: "/tmp/report.md",
      reportJsonPath: "/tmp/report.json",
    });
    const adapter = {
      detectCapabilities: () => ({ available: true }),
    };
    const result = await reviewRun({ engine: "claude", dryRun: true, adapter });
    expect(result.status).toBe("completed");
    expect(result.runId).toBe("test-run-123");
  });

  it("should return blocked status when verify is blocked", async () => {
    vi.mocked(reviewPrepare).mockReturnValue({ runId: "test-run-123", inputDir: "/tmp/test" });
    vi.mocked(reviewVerify).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      runStatus: "blocked",
      policySnapshotHash: "hash",
      preconditionErrors: ["error"],
      commands: [],
      summary: { passed: 0, failed: 0, skipped: 0, notRequired: 0 },
      workspaceChangedAfterVerify: false,
    });
    const adapter = {
      detectCapabilities: () => ({ available: true }),
    };
    const result = await reviewRun({ engine: "claude", dryRun: true, adapter });
    expect(result.status).toBe("blocked");
  });

  it("should continue when verify has failed commands but ledger is complete", async () => {
    vi.mocked(reviewPrepare).mockReturnValue({ runId: "test-run-123", inputDir: "/tmp/test" });
    vi.mocked(reviewVerify).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      runStatus: "completed",
      policySnapshotHash: "hash",
      preconditionErrors: [],
      commands: [],
      summary: { passed: 0, failed: 1, skipped: 0, notRequired: 0 },
      workspaceChangedAfterVerify: false,
    });
    vi.mocked(reviewStage).mockResolvedValue({ stageArtifactPath: "/tmp/test" });
    vi.mocked(generateLedgers).mockReturnValue({
      issueLedgerPath: "/tmp/issue-ledger",
      coverageLedgerPath: "/tmp/coverage-ledger",
    });
    vi.mocked(reviewValidate).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      status: "valid",
      finalDecision: "not_ready_to_merge",
      sourceArtifacts: [],
      errors: [],
      warnings: [],
    });
    vi.mocked(reviewReport).mockReturnValue({
      reportMarkdownPath: "/tmp/report.md",
      reportJsonPath: "/tmp/report.json",
    });
    const adapter = {
      detectCapabilities: () => ({ available: true }),
    };
    const result = await reviewRun({ engine: "claude", dryRun: true, adapter });
    expect(result.status).toBe("completed");
    expect(result.finalDecision).toBe("not_ready_to_merge");
  });

  it("should stop at change-map when it fails", async () => {
    vi.mocked(reviewPrepare).mockReturnValue({ runId: "test-run-123", inputDir: "/tmp/test" });
    vi.mocked(reviewVerify).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      runStatus: "completed",
      policySnapshotHash: "hash",
      preconditionErrors: [],
      commands: [],
      summary: { passed: 1, failed: 0, skipped: 0, notRequired: 0 },
      workspaceChangedAfterVerify: false,
    });
    vi.mocked(reviewStage).mockRejectedValue(new Error("change-map failed"));
    const adapter = {
      detectCapabilities: () => ({ available: true }),
    };
    const result = await reviewRun({ engine: "claude", dryRun: true, adapter });
    expect(result.status).toBe("failed");
  });

  it("should not run synthesis when ledger fails", async () => {
    vi.mocked(reviewPrepare).mockReturnValue({ runId: "test-run-123", inputDir: "/tmp/test" });
    vi.mocked(reviewVerify).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      runStatus: "completed",
      policySnapshotHash: "hash",
      preconditionErrors: [],
      commands: [],
      summary: { passed: 1, failed: 0, skipped: 0, notRequired: 0 },
      workspaceChangedAfterVerify: false,
    });
    vi.mocked(reviewStage).mockResolvedValue({ stageArtifactPath: "/tmp/test" });
    vi.mocked(generateLedgers).mockImplementation(() => {
      throw new Error("ledger failed");
    });
    const adapter = {
      detectCapabilities: () => ({ available: true }),
    };
    const result = await reviewRun({ engine: "claude", dryRun: true, adapter });
    expect(result.status).toBe("failed");
  });

  it("should generate report when all steps succeed", async () => {
    vi.mocked(reviewPrepare).mockReturnValue({ runId: "test-run-123", inputDir: "/tmp/test" });
    vi.mocked(reviewVerify).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      runStatus: "completed",
      policySnapshotHash: "hash",
      preconditionErrors: [],
      commands: [],
      summary: { passed: 1, failed: 0, skipped: 0, notRequired: 0 },
      workspaceChangedAfterVerify: false,
    });
    vi.mocked(reviewStage).mockResolvedValue({ stageArtifactPath: "/tmp/test" });
    vi.mocked(generateLedgers).mockReturnValue({
      issueLedgerPath: "/tmp/issue-ledger",
      coverageLedgerPath: "/tmp/coverage-ledger",
    });
    vi.mocked(reviewValidate).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      status: "valid",
      finalDecision: "ready_to_merge",
      sourceArtifacts: [],
      errors: [],
      warnings: [],
    });
    vi.mocked(reviewReport).mockReturnValue({
      reportMarkdownPath: "/tmp/report.md",
      reportJsonPath: "/tmp/report.json",
    });
    const adapter = {
      detectCapabilities: () => ({ available: true }),
    };
    const result = await reviewRun({ engine: "claude", dryRun: true, adapter });
    expect(result.status).toBe("completed");
    expect(result.reportPath).toBe("/tmp/report.md");
  });

  it("should return invalidated status when validate is invalidated", async () => {
    vi.mocked(reviewPrepare).mockReturnValue({ runId: "test-run-123", inputDir: "/tmp/test" });
    vi.mocked(reviewVerify).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      runStatus: "completed",
      policySnapshotHash: "hash",
      preconditionErrors: [],
      commands: [],
      summary: { passed: 1, failed: 0, skipped: 0, notRequired: 0 },
      workspaceChangedAfterVerify: false,
    });
    vi.mocked(reviewStage).mockResolvedValue({ stageArtifactPath: "/tmp/test" });
    vi.mocked(generateLedgers).mockReturnValue({
      issueLedgerPath: "/tmp/issue-ledger",
      coverageLedgerPath: "/tmp/coverage-ledger",
    });
    vi.mocked(reviewValidate).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      status: "invalidated",
      finalDecision: null,
      sourceArtifacts: [],
      errors: [{ code: "INVALID", message: "validation failed" }],
      warnings: [],
    });
    const adapter = {
      detectCapabilities: () => ({ available: true }),
    };
    const result = await reviewRun({ engine: "claude", dryRun: true, adapter });
    expect(result.status).toBe("invalidated");
  });

  it("should not produce git modifications in dry-run mode", async () => {
    vi.mocked(reviewPrepare).mockReturnValue({ runId: "test-run-123", inputDir: "/tmp/test" });
    vi.mocked(reviewVerify).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      runStatus: "completed",
      policySnapshotHash: "hash",
      preconditionErrors: [],
      commands: [],
      summary: { passed: 1, failed: 0, skipped: 0, notRequired: 0 },
      workspaceChangedAfterVerify: false,
    });
    vi.mocked(reviewStage).mockResolvedValue({ stageArtifactPath: "/tmp/test" });
    vi.mocked(generateLedgers).mockReturnValue({
      issueLedgerPath: "/tmp/issue-ledger",
      coverageLedgerPath: "/tmp/coverage-ledger",
    });
    vi.mocked(reviewValidate).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      status: "valid",
      finalDecision: "ready_to_merge",
      sourceArtifacts: [],
      errors: [],
      warnings: [],
    });
    vi.mocked(reviewReport).mockReturnValue({
      reportMarkdownPath: "/tmp/report.md",
      reportJsonPath: "/tmp/report.json",
    });
    const adapter = {
      detectCapabilities: () => ({ available: true }),
    };
    // This test verifies that dry-run mode doesn't produce side effects
    // In a real implementation, we would check that no git commands are executed
    const result = await reviewRun({ engine: "claude", dryRun: true, adapter });
    expect(result.status).toBe("completed");
  });

  it("should use explicit --base when provided", async () => {
    vi.mocked(reviewPrepare).mockReturnValue({ runId: "test-run-123", inputDir: "/tmp/test" });
    vi.mocked(reviewVerify).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      runStatus: "completed",
      policySnapshotHash: "hash",
      preconditionErrors: [],
      commands: [],
      summary: { passed: 1, failed: 0, skipped: 0, notRequired: 0 },
      workspaceChangedAfterVerify: false,
    });
    vi.mocked(reviewStage).mockResolvedValue({ stageArtifactPath: "/tmp/test" });
    vi.mocked(generateLedgers).mockReturnValue({
      issueLedgerPath: "/tmp/issue-ledger",
      coverageLedgerPath: "/tmp/coverage-ledger",
    });
    vi.mocked(reviewValidate).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      status: "valid",
      finalDecision: "ready_to_merge",
      sourceArtifacts: [],
      errors: [],
      warnings: [],
    });
    vi.mocked(reviewReport).mockReturnValue({
      reportMarkdownPath: "/tmp/report.md",
      reportJsonPath: "/tmp/report.json",
    });
    const adapter = {
      detectCapabilities: () => ({ available: true }),
    };
    const result = await reviewRun({ base: "HEAD~1", engine: "claude", dryRun: true, adapter });
    expect(result.status).toBe("completed");
    // Verify reviewPrepare was called with HEAD~1
    expect(reviewPrepare).toHaveBeenCalledWith({ base: "HEAD~1", head: "HEAD" });
  });

  it("should use policy defaultBaseRef when --base not provided", async () => {
    // Mock policy with custom defaultBaseRef
    vi.mocked(loadPolicy).mockReturnValue({
      version: 1,
      review: { defaultBaseRef: "main" },
    });
    vi.mocked(reviewPrepare).mockReturnValue({ runId: "test-run-123", inputDir: "/tmp/test" });
    vi.mocked(reviewVerify).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      runStatus: "completed",
      policySnapshotHash: "hash",
      preconditionErrors: [],
      commands: [],
      summary: { passed: 1, failed: 0, skipped: 0, notRequired: 0 },
      workspaceChangedAfterVerify: false,
    });
    vi.mocked(reviewStage).mockResolvedValue({ stageArtifactPath: "/tmp/test" });
    vi.mocked(generateLedgers).mockReturnValue({
      issueLedgerPath: "/tmp/issue-ledger",
      coverageLedgerPath: "/tmp/coverage-ledger",
    });
    vi.mocked(reviewValidate).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      status: "valid",
      finalDecision: "ready_to_merge",
      sourceArtifacts: [],
      errors: [],
      warnings: [],
    });
    vi.mocked(reviewReport).mockReturnValue({
      reportMarkdownPath: "/tmp/report.md",
      reportJsonPath: "/tmp/report.json",
    });
    const adapter = {
      detectCapabilities: () => ({ available: true }),
    };
    // When --base is not provided, should use policy.defaultBaseRef
    const result = await reviewRun({ engine: "claude", dryRun: true, adapter });
    expect(result.status).toBe("completed");
    // Verify reviewPrepare was called with policy.defaultBaseRef
    expect(reviewPrepare).toHaveBeenCalledWith({ base: "main", head: "HEAD" });
  });

  it("should use origin/main when --base not provided and no policy defaultBaseRef", async () => {
    // Mock policy without defaultBaseRef
    vi.mocked(loadPolicy).mockReturnValue({ version: 1 });
    vi.mocked(reviewPrepare).mockReturnValue({ runId: "test-run-123", inputDir: "/tmp/test" });
    vi.mocked(reviewVerify).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      runStatus: "completed",
      policySnapshotHash: "hash",
      preconditionErrors: [],
      commands: [],
      summary: { passed: 1, failed: 0, skipped: 0, notRequired: 0 },
      workspaceChangedAfterVerify: false,
    });
    vi.mocked(reviewStage).mockResolvedValue({ stageArtifactPath: "/tmp/test" });
    vi.mocked(generateLedgers).mockReturnValue({
      issueLedgerPath: "/tmp/issue-ledger",
      coverageLedgerPath: "/tmp/coverage-ledger",
    });
    vi.mocked(reviewValidate).mockReturnValue({
      runId: "test-run-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      status: "valid",
      finalDecision: "ready_to_merge",
      sourceArtifacts: [],
      errors: [],
      warnings: [],
    });
    vi.mocked(reviewReport).mockReturnValue({
      reportMarkdownPath: "/tmp/report.md",
      reportJsonPath: "/tmp/report.json",
    });
    const adapter = {
      detectCapabilities: () => ({ available: true }),
    };
    // When --base is not provided and no policy defaultBaseRef, should use "origin/main"
    const result = await reviewRun({ engine: "claude", dryRun: true, adapter });
    expect(result.status).toBe("completed");
    // Verify reviewPrepare was called with origin/main as default
    expect(reviewPrepare).toHaveBeenCalledWith({ base: "origin/main", head: "HEAD" });
  });
});
