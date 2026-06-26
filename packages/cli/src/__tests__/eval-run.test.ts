import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { evalRun } from "../eval-run.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../review-run.js", () => ({
  reviewRun: vi.fn(),
}));

import { reviewRun } from "../review-run.js";

describe("evalRun", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "change-assurance-eval-test-"));
    process.chdir(tempDir);
    vi.mocked(reviewRun).mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should exist", () => {
    expect(evalRun).toBeDefined();
  });

  it("should return failed result when case not found", async () => {
    const results = await evalRun({ caseId: "nonexistent", engine: "claude" });
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].pipelineStatus).toBe("failed");
    expect(results[0].failureReasons[0]).toContain("Case not found");
  });

  it("should return failed result when expectations.yaml missing", async () => {
    // Create case directory without expectations.yaml
    const caseDir = join(tempDir, "evals", "cases", "test-case", "repo", "src");
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, "index.js"), "module.exports = {};");

    const results = await evalRun({ caseId: "test-case", engine: "claude" });
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].failureReasons[0]).toContain("expectations.yaml not found");
  });

  it("should return failed result when repo directory missing", async () => {
    // Create case directory without repo/
    const caseDir = join(tempDir, "evals", "cases", "test-case");
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, "expectations.yaml"), "id: test-case");

    const results = await evalRun({ caseId: "test-case", engine: "claude" });
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].failureReasons[0]).toContain("repo directory not found");
  });

  it("should reject non-claude engine", async () => {
    await expect(
      evalRun({ caseId: "test", engine: "other" as any })
    ).rejects.toThrow("Unsupported engine");
  });

  it("should reject when neither --case nor --all specified", async () => {
    await expect(
      evalRun({ engine: "claude" })
    ).rejects.toThrow("Either --case or --all must be specified");
  });
});
