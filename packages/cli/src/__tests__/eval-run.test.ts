import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { evalRun } from "../eval-run.js";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
    await expect(evalRun({ caseId: "test", engine: "other" as any })).rejects.toThrow(
      "Unsupported engine",
    );
  });

  it("should reject when neither --case nor --all specified", async () => {
    await expect(evalRun({ engine: "claude" })).rejects.toThrow(
      "Either --case or --all must be specified",
    );
  });

  it("should run cases against a real base/head diff and ignore run artifacts", async () => {
    const caseId = "case-workspace";
    const caseRoot = join(tempDir, "evals", "cases", caseId);
    const repoSrc = join(caseRoot, "repo", "src");
    mkdirSync(repoSrc, { recursive: true });
    writeFileSync(join(repoSrc, "index.js"), "module.exports = { value: 1 };\n");
    writeFileSync(join(caseRoot, "repo", "change-assurance.yaml"), "version: 1\n");
    writeFileSync(join(caseRoot, "expectations.yaml"), `
id: ${caseId}
expected:
  allowedFinalDecisions:
    - ready_to_merge
  mustFind: []
  mustNotFind: []
`);

    const observed: {
      base?: string;
      head?: string;
      diffNames?: string[];
      status?: string;
      ignoredStatus?: string;
    } = {};

    vi.mocked(reviewRun).mockImplementation(async (options: any) => {
      observed.base = options.base;
      observed.head = options.head;

      const cwd = process.cwd();
      observed.diffNames = execFileSync("git", ["diff", "--name-only", "HEAD~1...HEAD"], {
        cwd,
        encoding: "utf-8",
      }).trim().split("\n").filter(Boolean);

      const runInputDir = join(cwd, ".change-assurance", "runs", "run-1", "input");
      mkdirSync(runInputDir, { recursive: true });
      writeFileSync(join(runInputDir, "git-state.json"), "{}\n");

      observed.status = execFileSync("git", ["status", "--short"], {
        cwd,
        encoding: "utf-8",
      }).trim();
      observed.ignoredStatus = execFileSync("git", ["status", "--short", "--ignored"], {
        cwd,
        encoding: "utf-8",
      });

      return {
        runId: "run-1",
        status: "completed",
        finalDecision: "ready_to_merge",
        summaryPath: join(cwd, ".change-assurance", "runs", "run-1", "execution", "run-summary.json"),
      };
    });

    const results = await evalRun({ caseId, engine: "claude" });

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(existsSync(join(tempDir, "evals", "results", caseId, "attempt-1", "eval-result.json"))).toBe(true);
    expect(observed.base).toBe("HEAD~1");
    expect(observed.head).toBe("HEAD");
    expect(observed.diffNames).toEqual(expect.arrayContaining(["change-assurance.yaml", "src/index.js"]));
    expect(observed.diffNames).not.toContain(".gitignore");
    expect(observed.status).toBe("");
    expect(observed.ignoredStatus).toContain("!! .change-assurance/");
  });

  it("should not treat every not_ready_to_merge decision as a merge-blocking violation", async () => {
    const caseId = "case-material-issue";
    const caseRoot = join(tempDir, "evals", "cases", caseId);
    const repoSrc = join(caseRoot, "repo", "src");
    mkdirSync(repoSrc, { recursive: true });
    writeFileSync(join(repoSrc, "index.js"), "module.exports = { value: 1 };\n");
    writeFileSync(join(caseRoot, "repo", "change-assurance.yaml"), "version: 1\n");
    writeFileSync(join(caseRoot, "expectations.yaml"), `
id: ${caseId}
expected:
  allowedFinalDecisions:
    - not_ready_to_merge
  mustFind: []
  mustNotFind:
    - mergeBlocking: true
      reason: "Material issue is not a blocker"
`);

    vi.mocked(reviewRun).mockImplementation(async () => {
      const cwd = process.cwd();
      const ledgersDir = join(cwd, ".change-assurance", "runs", "run-1", "ledgers");
      mkdirSync(ledgersDir, { recursive: true });
      writeFileSync(join(ledgersDir, "issue-ledger.json"), JSON.stringify({
        issues: [{
          id: "issue-1",
          candidateImpact: "material",
        }],
      }));

      return {
        runId: "run-1",
        status: "completed",
        finalDecision: "not_ready_to_merge",
        summaryPath: join(cwd, ".change-assurance", "runs", "run-1", "execution", "run-summary.json"),
      };
    });

    const results = await evalRun({ caseId, engine: "claude" });

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].scores.mustNotFind.violations).toEqual([]);
  });

  it("should not count an expected merge_blocking mustFind as a false blocker", async () => {
    const caseId = "case-expected-blocker";
    const caseRoot = join(tempDir, "evals", "cases", caseId);
    const repoSrc = join(caseRoot, "repo", "src");
    mkdirSync(repoSrc, { recursive: true });
    writeFileSync(join(repoSrc, "submit.js"), "module.exports = {};\n");
    writeFileSync(join(caseRoot, "repo", "change-assurance.yaml"), "version: 1\n");
    writeFileSync(join(caseRoot, "expectations.yaml"), `
id: ${caseId}
expected:
  allowedFinalDecisions:
    - not_ready_to_merge
  mustFind:
    - id: stuck-state
      sourceStage: behavior-review
      minImpact: merge_blocking
      evidencePaths:
        - src/submit.js
      anyTextPatterns:
        - isSubmitting
  mustNotFind:
    - mergeBlocking: true
      reason: "No unsupported blocker is allowed"
`);

    vi.mocked(reviewRun).mockImplementation(async () => {
      const cwd = process.cwd();
      const ledgersDir = join(cwd, ".change-assurance", "runs", "run-1", "ledgers");
      mkdirSync(ledgersDir, { recursive: true });
      writeFileSync(join(ledgersDir, "issue-ledger.json"), JSON.stringify({
        issues: [{
          id: "issue-1",
          sourceStage: "behavior-review",
          candidateImpact: "merge_blocking",
          title: "isSubmitting remains true after failure",
          summary: "confirmed state transition defect",
          evidenceRefs: ["git:abc123:src/submit.js#L1-L5"],
        }, {
          id: "issue-2",
          sourceStage: "behavior-review",
          candidateImpact: "merge_blocking",
          title: "isSubmitting remains true after success",
          summary: "same state lifecycle risk on another path",
          evidenceRefs: ["git:abc123:src/submit.js#L1-L5"],
        }],
      }));

      return {
        runId: "run-1",
        status: "completed",
        finalDecision: "not_ready_to_merge",
        summaryPath: join(cwd, ".change-assurance", "runs", "run-1", "execution", "run-summary.json"),
      };
    });

    const results = await evalRun({ caseId, engine: "claude" });

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].scores.mustFind.matched).toEqual(["stuck-state"]);
    expect(results[0].scores.mustNotFind.violations).toEqual([]);
  });
});
