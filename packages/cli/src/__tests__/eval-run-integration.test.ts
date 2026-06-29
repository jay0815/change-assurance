import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { evalRun } from "../eval-run.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("evalRun integration", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "change-assurance-eval-integration-"));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should complete a case with failed verification command", async () => {
    const caseRoot = join(tempDir, "evals", "cases", "case-verification-failure");
    const repoRoot = join(caseRoot, "repo");
    mkdirSync(join(repoRoot, "scripts"), { recursive: true });
    mkdirSync(join(repoRoot, "src"), { recursive: true });

    writeFileSync(
      join(caseRoot, "expectations.yaml"),
      [
        "id: case-verification-failure",
        "",
        "expected:",
        "  allowedFinalDecisions:",
        "    - not_ready_to_merge",
        "",
        "  mustFind: []",
        "",
        "  mustNotFind:",
        "    - mergeBlocking: true",
        '      reason: "Verification failure should not be scored as a blocker finding"',
        "",
        "  verification:",
        "    expectedFailedCommands:",
        "      - check",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(repoRoot, "change-assurance.yaml"),
      [
        "version: 1",
        "",
        "verification:",
        "  commands:",
        "    - id: check",
        '      argv: ["node", "scripts/check.mjs"]',
        "",
      ].join("\n"),
    );
    writeFileSync(join(repoRoot, "scripts", "check.mjs"), "process.exit(1);\n");
    writeFileSync(join(repoRoot, "src", "index.js"), "export const value = 1;\n");

    const results = await evalRun({
      caseId: "case-verification-failure",
      engine: "claude",
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      pipelineStatus: "completed",
      finalDecision: "not_ready_to_merge",
      passed: true,
      failureReasons: [],
    });
    expect(results[0].scores.verification.mismatches).toEqual([]);
  }, 15000);
});
