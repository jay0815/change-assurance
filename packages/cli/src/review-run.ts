import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  getExecutionDir,
  getRunSummaryPath,
} from "@change-assurance/core";
import { reviewPrepare } from "./review-prepare.js";
import { reviewVerify } from "./review-verify.js";
import { reviewStage } from "./review-stage.js";
import { generateLedgers } from "./review-ledger.js";
import { reviewValidate } from "./review-validate.js";
import { reviewReport } from "./review-report.js";
import { loadPolicy } from "./policy.js";
import type {
  VerificationLedger,
  ValidationResult,
} from "@change-assurance/core";

export interface RunOptions {
  base?: string;
  head?: string;
  engine: "claude";
  dryRun: boolean;
  adapter: any;
}

export class RunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunError";
  }
}

export type RunStepStatus =
  | "passed"
  | "failed"
  | "continued_with_findings"
  | "skipped";

export type RunStepName =
  | "prepare"
  | "verify"
  | "change-map"
  | "behavior-review"
  | "test-review"
  | "evidence-audit"
  | "ledger"
  | "synthesis"
  | "validate"
  | "report";

export interface RunStep {
  name: RunStepName;
  status: RunStepStatus;
  startedAt: string;
  endedAt: string;
  message?: string;
  artifactPath?: string;
}

export interface RunSummary {
  runId: string;
  mode: "pre_merge_review";
  executionMode: "dry_run";
  baseRef: string;
  headRef: string;
  engine: "claude";
  startedAt: string;
  endedAt: string;

  status: "completed" | "blocked" | "invalidated" | "failed";
  finalDecision?: string;

  steps: RunStep[];
  reportPath?: string;
}

export interface ReviewRunResult {
  runId: string;
  status: "completed" | "blocked" | "invalidated" | "failed";
  finalDecision?: string;
  reportPath?: string;
  summaryPath: string;
}

const STAGE_ORDER = ["change-map", "behavior-review", "test-review", "evidence-audit"];

function now(): string {
  return new Date().toISOString();
}

function createStep(name: RunStepName): RunStep {
  return {
    name,
    status: "passed",
    startedAt: now(),
    endedAt: now(),
  };
}

export async function reviewRun(options: RunOptions): Promise<ReviewRunResult> {
  const startedAt = now();
  const steps: RunStep[] = [];

  if (options.engine !== "claude") {
    throw new RunError(`Unsupported engine: ${options.engine}. Only claude is supported.`);
  }

  if (!options.dryRun) {
    throw new RunError("Only dry-run mode is supported. Pass --dry-run.");
  }

  const caps = options.adapter.detectCapabilities();
  if (!caps.available) {
    throw new RunError("Claude CLI not available.");
  }

  // Default refs - use policy.defaultBaseRef if available, otherwise "origin/main"
  const policy = loadPolicy(process.cwd());
  const defaultBase = policy.review?.defaultBaseRef ?? "origin/main";
  const base = options.base ?? defaultBase;
  const head = options.head ?? "HEAD";

  // Step 1: Prepare
  let runId: string;
  const prepareStep = createStep("prepare");
  steps.push(prepareStep);
  try {
    const result = reviewPrepare({ base, head });
    runId = result.runId;
    prepareStep.status = "passed";
    prepareStep.message = `Run created: ${runId}`;
    prepareStep.artifactPath = result.inputDir;
  } catch (error) {
    prepareStep.status = "failed";
    prepareStep.endedAt = now();
    prepareStep.message = error instanceof Error ? error.message : String(error);
    return writeRunSummaryAndReturn({
      runId: "unknown",
      baseRef: base,
      headRef: head,
      startedAt,
      steps,
      status: "failed",
    });
  }
  prepareStep.endedAt = now();

  // Step 2: Verify
  let verificationLedger: VerificationLedger;
  const verifyStep = createStep("verify");
  steps.push(verifyStep);
  try {
    verificationLedger = reviewVerify({ runId });
    verifyStep.artifactPath = resolve(process.cwd(), ".change-assurance/runs", runId, "verification/verification-ledger.json");

    if (verificationLedger.runStatus === "blocked" || verificationLedger.runStatus === "invalidated") {
      verifyStep.status = "failed";
      verifyStep.endedAt = now();
      verifyStep.message = `Verification ${verificationLedger.runStatus}`;
      return writeRunSummaryAndReturn({
        runId,
        baseRef: base,
        headRef: head,
        startedAt,
        steps,
        status: verificationLedger.runStatus,
      });
    }

    // Check for failed commands - this is "continued_with_findings"
    if (verificationLedger.summary.failed > 0) {
      verifyStep.status = "continued_with_findings";
      verifyStep.message = `${verificationLedger.summary.failed} verification command(s) failed`;
    } else {
      verifyStep.status = "passed";
    }
  } catch (error) {
    verifyStep.status = "failed";
    verifyStep.endedAt = now();
    verifyStep.message = error instanceof Error ? error.message : String(error);
    return writeRunSummaryAndReturn({
      runId,
      baseRef: base,
      headRef: head,
      startedAt,
      steps,
      status: "failed",
    });
  }
  verifyStep.endedAt = now();

  // Step 3-6: Run stages in order
  let hasStageFailure = false;
  for (const stageName of STAGE_ORDER) {
    const stageStep = createStep(stageName as RunStepName);
    steps.push(stageStep);

    if (hasStageFailure) {
      stageStep.status = "skipped";
      stageStep.endedAt = now();
      stageStep.message = "Skipped due to previous stage failure";
      continue;
    }

    try {
      await reviewStage({ runId, stage: stageName as any, adapter: options.adapter });
      stageStep.status = "passed";
      stageStep.endedAt = now();
    } catch (error) {
      stageStep.status = "failed";
      stageStep.endedAt = now();
      stageStep.message = error instanceof Error ? error.message : String(error);
      hasStageFailure = true;
    }
  }

  // If any stage failed, stop here
  if (hasStageFailure) {
    return writeRunSummaryAndReturn({
      runId,
      baseRef: base,
      headRef: head,
      startedAt,
      steps,
      status: "failed",
    });
  }

  // Step 7: Ledger
  const ledgerStep = createStep("ledger");
  steps.push(ledgerStep);
  try {
    const result = generateLedgers({ runId });
    ledgerStep.status = "passed";
    ledgerStep.artifactPath = result.issueLedgerPath;
  } catch (error) {
    ledgerStep.status = "failed";
    ledgerStep.endedAt = now();
    ledgerStep.message = error instanceof Error ? error.message : String(error);
    return writeRunSummaryAndReturn({
      runId,
      baseRef: base,
      headRef: head,
      startedAt,
      steps,
      status: "failed",
    });
  }
  ledgerStep.endedAt = now();

  // Step 8: Synthesis (requires ledgers)
  const synthesisStep = createStep("synthesis");
  steps.push(synthesisStep);
  try {
    await reviewStage({ runId, stage: "synthesis", adapter: options.adapter });
    synthesisStep.status = "passed";
    synthesisStep.endedAt = now();
  } catch (error) {
    synthesisStep.status = "failed";
    synthesisStep.endedAt = now();
    synthesisStep.message = error instanceof Error ? error.message : String(error);
    return writeRunSummaryAndReturn({
      runId,
      baseRef: base,
      headRef: head,
      startedAt,
      steps,
      status: "failed",
    });
  }

  // Step 9: Validate
  let validationResult: ValidationResult;
  const validateStep = createStep("validate");
  steps.push(validateStep);
  try {
    validationResult = reviewValidate({ runId });
    validateStep.artifactPath = resolve(process.cwd(), ".change-assurance/runs", runId, "validation/validation-result.json");

    if (validationResult.status !== "valid") {
      validateStep.status = "failed";
      validateStep.endedAt = now();
      validateStep.message = `Validation ${validationResult.status}`;
      return writeRunSummaryAndReturn({
        runId,
        baseRef: base,
        headRef: head,
        startedAt,
        steps,
        status: validationResult.status as "blocked" | "invalidated",
      });
    }
    validateStep.status = "passed";
  } catch (error) {
    validateStep.status = "failed";
    validateStep.endedAt = now();
    validateStep.message = error instanceof Error ? error.message : String(error);
    return writeRunSummaryAndReturn({
      runId,
      baseRef: base,
      headRef: head,
      startedAt,
      steps,
      status: "failed",
    });
  }
  validateStep.endedAt = now();

  // Step 10: Report
  const reportStep = createStep("report");
  steps.push(reportStep);
  let reportPath: string | undefined;
  try {
    const result = reviewReport({ runId });
    reportPath = result.reportMarkdownPath;
    reportStep.status = "passed";
    reportStep.artifactPath = result.reportMarkdownPath;
  } catch (error) {
    reportStep.status = "failed";
    reportStep.endedAt = now();
    reportStep.message = error instanceof Error ? error.message : String(error);
    return writeRunSummaryAndReturn({
      runId,
      baseRef: base,
      headRef: head,
      startedAt,
      steps,
      status: "failed",
    });
  }
  reportStep.endedAt = now();

  // Determine final decision
  const hasVerificationFailures = verificationLedger!.summary.failed > 0;
  const finalDecision = hasVerificationFailures ? "not_ready_to_merge" : (validationResult!.finalDecision ?? "ready_to_merge");

  return writeRunSummaryAndReturn({
    runId,
    baseRef: base,
    headRef: head,
    startedAt,
    steps,
    status: "completed",
    finalDecision,
    reportPath,
  });
}

function writeRunSummaryAndReturn(params: {
  runId: string;
  baseRef: string;
  headRef: string;
  startedAt: string;
  steps: RunStep[];
  status: "completed" | "blocked" | "invalidated" | "failed";
  finalDecision?: string;
  reportPath?: string;
}): ReviewRunResult {
  const endedAt = now();
  const cwd = process.cwd();

  const summary: RunSummary = {
    runId: params.runId,
    mode: "pre_merge_review",
    executionMode: "dry_run",
    baseRef: params.baseRef,
    headRef: params.headRef,
    engine: "claude",
    startedAt: params.startedAt,
    endedAt,
    status: params.status,
    finalDecision: params.finalDecision,
    steps: params.steps,
    reportPath: params.reportPath,
  };

  // Only write summary if we have a valid runId
  if (params.runId !== "unknown") {
    const executionDir = resolve(cwd, getExecutionDir(params.runId));
    mkdirSync(executionDir, { recursive: true });
    writeFileSync(
      resolve(cwd, getRunSummaryPath(params.runId)),
      JSON.stringify(summary, null, 2),
    );
  }

  return {
    runId: params.runId,
    status: params.status,
    finalDecision: params.finalDecision,
    reportPath: params.reportPath,
    summaryPath: params.runId !== "unknown"
      ? resolve(cwd, getRunSummaryPath(params.runId))
      : "",
  };
}
