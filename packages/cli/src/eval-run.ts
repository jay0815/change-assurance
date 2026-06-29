import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { reviewRun } from "./review-run.js";
import type { ReviewRunResult } from "./review-run.js";
import type { VerificationLedger } from "@change-assurance/core";

export interface EvalRunOptions {
  caseId?: string;
  all?: boolean;
  engine: "claude";
  repeat?: number;
}

export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalError";
  }
}

export interface EvalExpectations {
  id: string;
  expected: {
    allowedFinalDecisions: string[];
    mustFind: Array<{
      id: string;
      sourceStage: string;
      minImpact: string;
      evidencePaths: string[];
      anyTextPatterns: string[];
    }>;
    mustNotFind: Array<{
      mergeBlocking?: boolean;
      reason?: string;
    }>;
    coverage?: {
      requiredAreas: string[];
    };
    verification?: {
      expectedFailedCommands: string[];
    };
  };
}

export interface EvalResult {
  caseId: string;
  attempt: number;
  runId?: string;

  pipelineStatus: "completed" | "blocked" | "invalidated" | "failed";
  finalDecision?: string;

  passed: boolean;
  scores: {
    decision: boolean;
    mustFind: { matched: string[]; missing: string[] };
    mustNotFind: { violations: string[] };
    coverage: { missingAreas: string[] };
    verification: { mismatches: string[] };
  };

  failureReasons: string[];
}

const EVALS_DIR = "evals";
const CASES_DIR = "cases";
const WORKSPACES_DIR = "workspaces";
const RESULTS_DIR = "results";

function loadCurrentVerificationLedger(runDirectory: string): VerificationLedger | undefined {
  const runsDir = join(runDirectory, ".change-assurance", "runs");
  if (!existsSync(runsDir)) {
    return undefined;
  }

  const runEntry = readdirSync(runsDir, { withFileTypes: true }).find((entry) =>
    entry.isDirectory(),
  );
  if (!runEntry) {
    return undefined;
  }

  const ledgerPath = join(runsDir, runEntry.name, "verification", "verification-ledger.json");
  if (!existsSync(ledgerPath)) {
    return undefined;
  }

  return JSON.parse(readFileSync(ledgerPath, "utf-8")) as VerificationLedger;
}

function getVerificationSummary(
  ledger: VerificationLedger | undefined,
): VerificationLedger["summary"] {
  return ledger?.summary ?? { passed: 0, failed: 0, skipped: 0, notRequired: 0 };
}

function getTestCommandStatus(
  summary: VerificationLedger["summary"],
): "passed" | "failed" | "not_required" | "unavailable" {
  if (summary.failed > 0) {
    return "failed";
  }
  if (summary.passed > 0) {
    return "passed";
  }
  if (summary.notRequired > 0) {
    return "not_required";
  }
  return "unavailable";
}

function getCaseDir(caseId: string): string {
  return resolve(process.cwd(), EVALS_DIR, CASES_DIR, caseId);
}

function getWorkspaceDir(caseId: string, attempt: number): string {
  return resolve(process.cwd(), EVALS_DIR, WORKSPACES_DIR, `${caseId}-${attempt}`);
}

function getResultsDir(caseId: string, attempt: number): string {
  return resolve(process.cwd(), EVALS_DIR, RESULTS_DIR, caseId, `attempt-${attempt}`);
}

function loadExpectations(caseId: string): EvalExpectations {
  const caseDir = getCaseDir(caseId);
  const expectationsPath = join(caseDir, "expectations.yaml");

  if (!existsSync(expectationsPath)) {
    throw new EvalError(`expectations.yaml not found for case: ${caseId}`);
  }

  const content = readFileSync(expectationsPath, "utf-8");
  return parse(content) as EvalExpectations;
}

function validateCase(caseId: string): void {
  const caseDir = getCaseDir(caseId);

  if (!existsSync(caseDir)) {
    throw new EvalError(`Case not found: ${caseId}`);
  }

  const repoDir = join(caseDir, "repo");
  if (!existsSync(repoDir)) {
    throw new EvalError(`repo directory not found for case: ${caseId}`);
  }

  loadExpectations(caseId);
}

function createWorkspace(caseId: string, attempt: number): string {
  const caseDir = getCaseDir(caseId);
  const repoDir = join(caseDir, "repo");
  const workspaceDir = getWorkspaceDir(caseId, attempt);

  // Clean up existing workspace
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }

  // Copy repo to workspace
  cpSync(repoDir, workspaceDir, { recursive: true });

  // Create .gitignore to exclude change-assurance artifacts
  writeFileSync(join(workspaceDir, ".gitignore"), ".change-assurance/\n");

  // Initialize git repo
  execFileSync("git", ["init"], { cwd: workspaceDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "eval@test.com"], {
    cwd: workspaceDir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Eval Test"], { cwd: workspaceDir, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: workspaceDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspaceDir, stdio: "ignore" });

  // Create a second commit so HEAD~1 exists
  writeFileSync(join(workspaceDir, ".gitkeep"), "");
  execFileSync("git", ["add", ".gitkeep"], { cwd: workspaceDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add .gitkeep"], { cwd: workspaceDir, stdio: "ignore" });

  return workspaceDir;
}

function scoreResult(
  expectations: EvalExpectations,
  runResult: ReviewRunResult,
  runDir: string,
): EvalResult["scores"] {
  const scores: EvalResult["scores"] = {
    decision: false,
    mustFind: { matched: [], missing: [] },
    mustNotFind: { violations: [] },
    coverage: { missingAreas: [] },
    verification: { mismatches: [] },
  };
  const issueLedgerPath = join(runDir, "ledgers", "issue-ledger.json");
  const issueLedger = existsSync(issueLedgerPath)
    ? JSON.parse(readFileSync(issueLedgerPath, "utf-8"))
    : undefined;

  // Score decision
  scores.decision = expectations.expected.allowedFinalDecisions.includes(
    runResult.finalDecision ?? "",
  );

  // Score mustFind
  if (runResult.status === "completed" && runResult.runId) {
    if (issueLedger) {
      for (const expected of expectations.expected.mustFind) {
        const found = issueLedger.issues.some((issue: any) => {
          // Check sourceStage
          if (issue.sourceStage !== expected.sourceStage) return false;

          // Check minImpact
          const impactOrder = ["advisory", "material", "merge_blocking", "needs_context"];
          const issueImpactIdx = impactOrder.indexOf(issue.candidateImpact);
          const minImpactIdx = impactOrder.indexOf(expected.minImpact);
          if (issueImpactIdx < minImpactIdx) return false;

          // Check evidencePaths
          const hasEvidence = expected.evidencePaths.some((path) =>
            issue.evidenceRefs?.some((ref: string) => ref.includes(path)),
          );
          if (!hasEvidence) return false;

          // Check anyTextPatterns
          const text = [issue.title, issue.summary, issue.trigger, issue.impact]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          const hasPattern = expected.anyTextPatterns.some((pattern) =>
            text.includes(pattern.toLowerCase()),
          );
          return hasPattern;
        });

        if (found) {
          scores.mustFind.matched.push(expected.id);
        } else {
          scores.mustFind.missing.push(expected.id);
        }
      }
    }
  }

  // Score mustNotFind
  for (const rule of expectations.expected.mustNotFind) {
    if (rule.mergeBlocking) {
      const hasMergeBlockingIssue =
        issueLedger?.issues?.some((issue: any) => issue.candidateImpact === "merge_blocking") ??
        false;
      if (hasMergeBlockingIssue) {
        scores.mustNotFind.violations.push(rule.reason ?? "Unexpected blocker");
      }
    }
  }

  // Score coverage
  if (expectations.expected.coverage?.requiredAreas) {
    const coverageLedgerPath = join(runDir, "ledgers", "coverage-ledger.json");
    if (existsSync(coverageLedgerPath)) {
      const coverageLedger = JSON.parse(readFileSync(coverageLedgerPath, "utf-8"));

      for (const area of expectations.expected.coverage.requiredAreas) {
        const covered = coverageLedger.items?.some(
          (item: any) =>
            item.paths?.some((p: string) => p.includes(area)) || item.area?.includes(area),
        );
        if (!covered) {
          scores.coverage.missingAreas.push(area);
        }
      }
    }
  }

  // Score verification
  if (expectations.expected.verification?.expectedFailedCommands) {
    const verificationLedgerPath = join(runDir, "verification", "verification-ledger.json");
    if (existsSync(verificationLedgerPath)) {
      const verificationLedger = JSON.parse(readFileSync(verificationLedgerPath, "utf-8"));

      const actualFailed =
        verificationLedger.commands
          ?.filter((cmd: any) => cmd.status === "failed")
          .map((cmd: any) => cmd.id) ?? [];

      const expectedFailed = expectations.expected.verification.expectedFailedCommands;

      // Check for mismatches
      for (const expected of expectedFailed) {
        if (!actualFailed.includes(expected)) {
          scores.verification.mismatches.push(`Expected ${expected} to fail, but it passed`);
        }
      }

      for (const actual of actualFailed) {
        if (!expectedFailed.includes(actual)) {
          scores.verification.mismatches.push(`Unexpected failure: ${actual}`);
        }
      }
    }
  }

  return scores;
}

function determinePassed(scores: EvalResult["scores"], pipelineStatus: string): boolean {
  // Pipeline must be completed
  if (pipelineStatus !== "completed") return false;

  // Decision must pass
  if (!scores.decision) return false;

  // All mustFind must be matched
  if (scores.mustFind.missing.length > 0) return false;

  // No mustNotFind violations
  if (scores.mustNotFind.violations.length > 0) return false;

  // No verification mismatches
  if (scores.verification.mismatches.length > 0) return false;

  return true;
}

export async function evalRun(options: EvalRunOptions): Promise<EvalResult[]> {
  const { caseId, all, engine, repeat = 1 } = options;

  if (engine !== "claude") {
    throw new EvalError(`Unsupported engine: ${engine}. Only claude is supported.`);
  }

  // Determine which cases to run
  const caseIds: string[] = [];
  if (all) {
    const casesDir = resolve(process.cwd(), EVALS_DIR, CASES_DIR);
    if (!existsSync(casesDir)) {
      throw new EvalError(`Cases directory not found: ${casesDir}`);
    }
    const entries = readdirSync(casesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("case-")) {
        caseIds.push(entry.name);
      }
    }
  } else if (caseId) {
    caseIds.push(caseId);
  } else {
    throw new EvalError("Either --case or --all must be specified");
  }

  const results: EvalResult[] = [];

  for (const cid of caseIds) {
    try {
      validateCase(cid);
    } catch (error) {
      results.push({
        caseId: cid,
        attempt: 0,
        pipelineStatus: "failed",
        passed: false,
        scores: {
          decision: false,
          mustFind: { matched: [], missing: [] },
          mustNotFind: { violations: [] },
          coverage: { missingAreas: [] },
          verification: { mismatches: [] },
        },
        failureReasons: [error instanceof Error ? error.message : String(error)],
      });
      continue;
    }

    const expectations = loadExpectations(cid);

    for (let attempt = 1; attempt <= repeat; attempt++) {
      const result = await runSingleAttempt(cid, attempt, expectations);
      results.push(result);
    }
  }

  return results;
}

async function runSingleAttempt(
  caseId: string,
  attempt: number,
  expectations: EvalExpectations,
): Promise<EvalResult> {
  const workspaceDir = createWorkspace(caseId, attempt);

  // Change to workspace directory
  const originalCwd = process.cwd();
  process.chdir(workspaceDir);

  try {
    // Run review pipeline
    const runResult = await reviewRun({
      base: "HEAD~1",
      head: "HEAD",
      engine: "claude",
      dryRun: true,
      adapter: {
        detectCapabilities: () => ({ available: true }),
        runStage: async (input: any) => {
          // Return minimal valid output for each stage
          const structuredOutput: any = {};
          const verificationLedger = loadCurrentVerificationLedger(input.runDirectory);
          const verificationSummary = getVerificationSummary(verificationLedger);

          if (input.stage === "change-map") {
            structuredOutput.changedModules = [
              { path: ".gitkeep", role: "file", changeSummary: "minor change" },
            ];
            structuredOutput.behaviorChanges = [];
            structuredOutput.riskAreas = [];
            structuredOutput.reviewPriorities = [];
            structuredOutput.uncoveredContext = [];
            structuredOutput.assumptions = ["Minor file change, no significant behavior impact"];
          } else if (input.stage === "behavior-review") {
            structuredOutput.reviewedAreas = [
              { area: "general", paths: [".gitkeep"], focus: "file change", evidenceRefs: [] },
            ];
            structuredOutput.findings = [];
            structuredOutput.uncoveredContext = [];
            structuredOutput.assumptions = [];
          } else if (input.stage === "test-review") {
            structuredOutput.reviewedBehaviors = [];
            structuredOutput.findings = [];
            structuredOutput.verificationAssessment = {
              testCommandStatus: getTestCommandStatus(verificationSummary),
              note: "Derived from eval verification ledger",
            };
            structuredOutput.uncoveredContext = [];
            structuredOutput.assumptions = [];
          } else if (input.stage === "evidence-audit") {
            structuredOutput.auditedFindings = [];
            structuredOutput.summary = { accepted: 0, downgraded: 0, needsContext: 0, rejected: 0 };
          } else if (input.stage === "synthesis") {
            structuredOutput.issueGroups = [];
            structuredOutput.recommendation =
              verificationSummary.failed > 0 ? "not_ready_to_merge" : "insufficient_evidence";
            structuredOutput.recommendationRationale =
              verificationSummary.failed > 0 ? "Verification failed" : "No issues found";
            structuredOutput.verificationSummary = verificationSummary;
            structuredOutput.uncoveredSummary = [];
            structuredOutput.assumptions = [];
          }

          return { rawOutput: { messages: [] }, structuredOutput };
        },
      },
    });

    // Score the result
    const runDir = resolve(workspaceDir, ".change-assurance", "runs", runResult.runId);
    const scores = scoreResult(expectations, runResult, runDir);
    const passed = determinePassed(scores, runResult.status);

    // Build failure reasons
    const failureReasons: string[] = [];
    if (!scores.decision) {
      failureReasons.push(
        `Decision mismatch: got ${runResult.finalDecision}, expected ${expectations.expected.allowedFinalDecisions.join(" or ")}`,
      );
    }
    if (scores.mustFind.missing.length > 0) {
      failureReasons.push(`Missing required findings: ${scores.mustFind.missing.join(", ")}`);
    }
    if (scores.mustNotFind.violations.length > 0) {
      failureReasons.push(`Unexpected findings: ${scores.mustNotFind.violations.join(", ")}`);
    }
    if (scores.verification.mismatches.length > 0) {
      failureReasons.push(`Verification mismatches: ${scores.verification.mismatches.join(", ")}`);
    }

    // Save result
    const resultsDir = getResultsDir(caseId, attempt);
    mkdirSync(resultsDir, { recursive: true });

    const evalResult: EvalResult = {
      caseId,
      attempt,
      runId: runResult.runId,
      pipelineStatus: runResult.status,
      finalDecision: runResult.finalDecision,
      passed,
      scores,
      failureReasons,
    };

    writeFileSync(join(resultsDir, "eval-result.json"), JSON.stringify(evalResult, null, 2));

    // Copy review run reference
    if (runResult.summaryPath && existsSync(runResult.summaryPath)) {
      writeFileSync(
        join(resultsDir, "review-run-reference.json"),
        readFileSync(runResult.summaryPath, "utf-8"),
      );
    }

    return evalResult;
  } finally {
    process.chdir(originalCwd);
  }
}
