#!/usr/bin/env node

import { resolve } from "node:path";
import { reviewPrepare, PrepareError } from "./review-prepare.js";
import { reviewVerify, VerifyError } from "./review-verify.js";
import { reviewStage, StageError } from "./review-stage.js";
import { generateLedgers, LedgerError } from "./review-ledger.js";
import { reviewValidate, ValidateError } from "./review-validate.js";
import { reviewReport, ReportError } from "./review-report.js";
import { reviewRun, RunError } from "./review-run.js";
import { evalRun, EvalError } from "./eval-run.js";
import { ClaudeAdapter, AdapterError } from "@change-assurance/adapter-claude";
import { GitError, getValidationResultPath } from "@change-assurance/core";

function printUsage(): void {
  console.log(`
Usage: ca <command> [options]

Commands:
  review prepare    Prepare a review run
  review verify     Verify a review run
  review stage      Run a review stage
  review ledger     Generate issue and coverage ledgers
  review validate   Validate artifact chain integrity
  review report     Generate review report
  review run        Run complete review pipeline
  eval run          Run evaluation cases

Options:
  --help            Show this help message

Prepare:
  ca review prepare --base <ref> --head <ref>

Verify:
  ca review verify --run <run-id>

Stage:
  ca review stage --run <run-id> --stage change-map --engine claude
  ca review stage --run <run-id> --stage behavior-review --engine claude
  ca review stage --run <run-id> --stage test-review --engine claude
  ca review stage --run <run-id> --stage evidence-audit --engine claude
  ca review stage --run <run-id> --stage synthesis --engine claude

Run:
  ca review run --base <ref> --head <ref> --engine claude --dry-run

Eval:
  ca eval run --case <case-id> --engine claude
  ca eval run --all --engine claude [--repeat <n>]
`);
}

function printPrepareUsage(): void {
  console.log(`
Usage: ca review prepare --base <ref> --head <ref>

Options:
  --base <ref>    Base git reference (e.g., origin/main)
  --head <ref>    Head git reference (e.g., HEAD)
  --help          Show this help message

Example:
  ca review prepare --base origin/main --head HEAD
`);
}

function printVerifyUsage(): void {
  console.log(`
Usage: ca review verify --run <run-id>

Options:
  --run <run-id>  Run ID from prepare step
  --json          Output as JSON
  --help          Show this help message

Example:
  ca review verify --run 4bb77790-572c-4407-940c-c3074cb90f8a
`);
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  printUsage();
  process.exit(0);
}

// Parse command
const command = args[0];
const subcommand = args[1];

if (command === "review") {
  if (subcommand === "prepare") {
    const prepareArgs = args.slice(2);
    if (prepareArgs.includes("--help")) {
      printPrepareUsage();
      process.exit(0);
    }

    let base: string | undefined;
    let head: string | undefined;
    for (let i = 0; i < prepareArgs.length; i++) {
      if (prepareArgs[i] === "--base" && prepareArgs[i + 1]) {
        base = prepareArgs[++i];
      } else if (prepareArgs[i] === "--head" && prepareArgs[i + 1]) {
        head = prepareArgs[++i];
      }
    }

    if (!base || !head) {
      console.error("Error: --base and --head are required");
      printPrepareUsage();
      process.exit(1);
    }

    try {
      const { runId, inputDir } = reviewPrepare({ base, head });
      console.log(`Run created: ${runId}`);
      console.log(`Artifacts: ${inputDir}`);
    } catch (error) {
      if (error instanceof PrepareError || error instanceof GitError) {
        console.error(`Error: ${error.message}`);
      } else if (error instanceof Error) {
        console.error("Unexpected error:", error.message);
      } else {
        console.error("Unexpected error:", error);
      }
      process.exit(1);
    }
  } else if (subcommand === "verify") {
    const verifyArgs = args.slice(2);
    if (verifyArgs.includes("--help")) {
      printVerifyUsage();
      process.exit(0);
    }

    let runId: string | undefined;
    let jsonOutput = false;
    for (let i = 0; i < verifyArgs.length; i++) {
      if (verifyArgs[i] === "--run" && verifyArgs[i + 1]) {
        runId = verifyArgs[++i];
      } else if (verifyArgs[i] === "--json") {
        jsonOutput = true;
      }
    }

    if (!runId) {
      console.error("Error: --run is required");
      printVerifyUsage();
      process.exit(1);
    }

    try {
      const ledger = reviewVerify({ runId });

      if (jsonOutput) {
        console.log(JSON.stringify(ledger, null, 2));
      } else {
        console.log(`Verification completed: ${ledger.runId}`);
        console.log(`Status: ${ledger.runStatus}`);
        console.log(`Summary:`);
        console.log(`  Passed: ${ledger.summary.passed}`);
        console.log(`  Failed: ${ledger.summary.failed}`);
        console.log(`  Skipped: ${ledger.summary.skipped}`);
        console.log(`  Not Required: ${ledger.summary.notRequired}`);

        if (ledger.preconditionErrors.length > 0) {
          console.log(`\nPrecondition Errors:`);
          ledger.preconditionErrors.forEach((err) => console.log(`  - ${err}`));
        }

        if (ledger.workspaceChangedAfterVerify) {
          console.log(`\nWarning: Workspace changed after verify (invalidated)`);
        }

        console.log(
          `\nLedger: .change-assurance/runs/${runId}/verification/verification-ledger.json`,
        );
      }

      // Exit with non-zero if blocked, invalidated, or has failures
      if (
        ledger.runStatus === "blocked" ||
        ledger.runStatus === "invalidated" ||
        ledger.summary.failed > 0
      ) {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof VerifyError) {
        console.error(`Error: ${error.message}`);
      } else if (error instanceof Error) {
        console.error("Unexpected error:", error.message);
      } else {
        console.error("Unexpected error:", error);
      }
      process.exit(1);
    }
  } else if (subcommand === "stage") {
    const stageArgs = args.slice(2);
    if (stageArgs.includes("--help")) {
      printStageUsage();
      process.exit(0);
    }

    let runId: string | undefined;
    let stage: string | undefined;
    let engine: string | undefined;
    for (let i = 0; i < stageArgs.length; i++) {
      if (stageArgs[i] === "--run" && stageArgs[i + 1]) {
        runId = stageArgs[++i];
      } else if (stageArgs[i] === "--stage" && stageArgs[i + 1]) {
        stage = stageArgs[++i];
      } else if (stageArgs[i] === "--engine" && stageArgs[i + 1]) {
        engine = stageArgs[++i];
      }
    }

    if (!runId || !stage || !engine) {
      console.error("Error: --run, --stage, and --engine are required");
      printStageUsage();
      process.exit(1);
    }

    if (
      stage !== "change-map" &&
      stage !== "behavior-review" &&
      stage !== "test-review" &&
      stage !== "evidence-audit" &&
      stage !== "synthesis"
    ) {
      console.error(
        `Error: Unsupported stage: ${stage}. Supported: change-map, behavior-review, test-review, evidence-audit, synthesis.`,
      );
      process.exit(1);
    }

    if (engine !== "claude") {
      console.error(`Error: Unsupported engine: ${engine}. Only claude is supported.`);
      process.exit(1);
    }

    try {
      const adapter = new ClaudeAdapter();
      const caps = adapter.detectCapabilities();
      if (!caps.available) {
        console.error("Error: Claude CLI not available");
        process.exit(1);
      }

      const { stageArtifactPath } = await reviewStage({ runId, stage: stage as any, adapter });
      console.log(`Stage completed: ${stage}`);
      console.log(`Artifact: ${stageArtifactPath}`);
    } catch (error) {
      if (error instanceof StageError || error instanceof AdapterError) {
        console.error(`Error: ${error.message}`);
      } else if (error instanceof Error) {
        console.error("Unexpected error:", error.message);
      } else {
        console.error("Unexpected error:", error);
      }
      process.exit(1);
    }
  } else if (subcommand === "ledger") {
    const ledgerArgs = args.slice(2);
    if (ledgerArgs.includes("--help")) {
      printLedgerUsage();
      process.exit(0);
    }

    let runId: string | undefined;
    let jsonOutput = false;
    for (let i = 0; i < ledgerArgs.length; i++) {
      if (ledgerArgs[i] === "--run" && ledgerArgs[i + 1]) {
        runId = ledgerArgs[++i];
      } else if (ledgerArgs[i] === "--json") {
        jsonOutput = true;
      }
    }

    if (!runId) {
      console.error("Error: --run is required");
      printLedgerUsage();
      process.exit(1);
    }

    try {
      const result = generateLedgers({ runId });

      if (jsonOutput) {
        const { readFileSync: readFile } = await import("node:fs");
        const issueLedger = JSON.parse(readFile(result.issueLedgerPath, "utf-8"));
        const coverageLedger = JSON.parse(readFile(result.coverageLedgerPath, "utf-8"));
        console.log(
          JSON.stringify(
            { issueLedger: issueLedger.summary, coverageLedger: coverageLedger.summary },
            null,
            2,
          ),
        );
      } else {
        console.log(`Ledgers generated:`);
        console.log(`  Issue Ledger: ${result.issueLedgerPath}`);
        console.log(`  Coverage Ledger: ${result.coverageLedgerPath}`);
      }
    } catch (error) {
      if (error instanceof LedgerError) {
        console.error(`Error: ${error.message}`);
      } else if (error instanceof Error) {
        console.error("Unexpected error:", error.message);
      } else {
        console.error("Unexpected error:", error);
      }
      process.exit(1);
    }
  } else if (subcommand === "validate") {
    const validateArgs = args.slice(2);
    if (validateArgs.includes("--help")) {
      printValidateUsage();
      process.exit(0);
    }

    let runId: string | undefined;
    for (let i = 0; i < validateArgs.length; i++) {
      if (validateArgs[i] === "--run" && validateArgs[i + 1]) {
        runId = validateArgs[++i];
      }
    }

    if (!runId) {
      console.error("Error: --run is required");
      printValidateUsage();
      process.exit(1);
    }

    try {
      const result = reviewValidate({ runId });
      console.log(`Validation completed: ${result.status}`);
      if (result.finalDecision) {
        console.log(`Final Decision: ${result.finalDecision}`);
      }
      console.log(`Artifact: ${resolve(process.cwd(), getValidationResultPath(runId))}`);

      if (result.errors.length > 0) {
        console.log(`\nErrors:`);
        result.errors.forEach((err) => console.log(`  - [${err.code}] ${err.message}`));
      }

      if (result.status !== "valid") {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof ValidateError) {
        console.error(`Error: ${error.message}`);
      } else if (error instanceof Error) {
        console.error("Unexpected error:", error.message);
      } else {
        console.error("Unexpected error:", error);
      }
      process.exit(1);
    }
  } else if (subcommand === "report") {
    const reportArgs = args.slice(2);
    if (reportArgs.includes("--help")) {
      printReportUsage();
      process.exit(0);
    }

    let runId: string | undefined;
    for (let i = 0; i < reportArgs.length; i++) {
      if (reportArgs[i] === "--run" && reportArgs[i + 1]) {
        runId = reportArgs[++i];
      }
    }

    if (!runId) {
      console.error("Error: --run is required");
      printReportUsage();
      process.exit(1);
    }

    try {
      const result = reviewReport({ runId });
      console.log(`Report generated:`);
      console.log(`  Markdown: ${result.reportMarkdownPath}`);
      console.log(`  JSON: ${result.reportJsonPath}`);
    } catch (error) {
      if (error instanceof ReportError) {
        console.error(`Error: ${error.message}`);
      } else if (error instanceof Error) {
        console.error("Unexpected error:", error.message);
      } else {
        console.error("Unexpected error:", error);
      }
      process.exit(1);
    }
  } else if (subcommand === "run") {
    const runArgs = args.slice(2);
    if (runArgs.includes("--help")) {
      printRunUsage();
      process.exit(0);
    }

    let base: string | undefined;
    let head: string | undefined;
    let engine: string | undefined;
    let dryRun = false;
    for (let i = 0; i < runArgs.length; i++) {
      if (runArgs[i] === "--base" && runArgs[i + 1]) {
        base = runArgs[++i];
      } else if (runArgs[i] === "--head" && runArgs[i + 1]) {
        head = runArgs[++i];
      } else if (runArgs[i] === "--engine" && runArgs[i + 1]) {
        engine = runArgs[++i];
      } else if (runArgs[i] === "--dry-run") {
        dryRun = true;
      }
    }

    if (!engine) {
      console.error("Error: --engine is required");
      printRunUsage();
      process.exit(1);
    }

    if (!dryRun) {
      console.error("Error: --dry-run is required");
      printRunUsage();
      process.exit(1);
    }

    try {
      const adapter = new ClaudeAdapter();
      const result = await reviewRun({
        base,
        head,
        engine: engine as "claude",
        dryRun,
        adapter,
      });

      if (result.status === "completed") {
        console.log(`Review completed: ${result.runId}`);
        console.log(`Decision: ${result.finalDecision ?? "unknown"}`);
        console.log(`Report: ${result.reportPath ?? "N/A"}`);
      } else {
        console.error(`Review did not complete: ${result.runId}`);
        console.error(`Status: ${result.status}`);
        console.error(`Run summary: ${result.summaryPath}`);
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof RunError || error instanceof AdapterError) {
        console.error(`Error: ${error.message}`);
      } else if (error instanceof Error) {
        console.error("Unexpected error:", error.message);
      } else {
        console.error("Unexpected error:", error);
      }
      process.exit(1);
    }
  } else {
    console.error(`Unknown subcommand: ${subcommand}`);
    printUsage();
    process.exit(1);
  }
} else if (command === "eval") {
  if (subcommand === "run") {
    const evalArgs = args.slice(2);
    if (evalArgs.includes("--help")) {
      printEvalUsage();
      process.exit(0);
    }

    let caseId: string | undefined;
    let all = false;
    let engine: string | undefined;
    let repeat = 1;
    for (let i = 0; i < evalArgs.length; i++) {
      if (evalArgs[i] === "--case" && evalArgs[i + 1]) {
        caseId = evalArgs[++i];
      } else if (evalArgs[i] === "--all") {
        all = true;
      } else if (evalArgs[i] === "--engine" && evalArgs[i + 1]) {
        engine = evalArgs[++i];
      } else if (evalArgs[i] === "--repeat" && evalArgs[i + 1]) {
        repeat = parseInt(evalArgs[++i], 10);
      }
    }

    if (!engine) {
      console.error("Error: --engine is required");
      printEvalUsage();
      process.exit(1);
    }

    if (!caseId && !all) {
      console.error("Error: --case or --all is required");
      printEvalUsage();
      process.exit(1);
    }

    try {
      const results = await evalRun({
        caseId,
        all,
        engine: engine as "claude",
        repeat,
      });

      // Print results
      let allPassed = true;
      for (const result of results) {
        const status = result.passed ? "PASS" : "FAIL";
        console.log(`\n[${status}] ${result.caseId} (attempt ${result.attempt})`);
        if (result.runId) {
          console.log(`  Run ID: ${result.runId}`);
        }
        console.log(`  Pipeline: ${result.pipelineStatus}`);
        console.log(`  Decision: ${result.finalDecision ?? "N/A"}`);
        console.log(`  Passed: ${result.passed}`);

        if (result.failureReasons.length > 0) {
          console.log(`  Failures:`);
          for (const reason of result.failureReasons) {
            console.log(`    - ${reason}`);
          }
        }

        if (!result.passed) {
          allPassed = false;
        }
      }

      // Print summary for repeat > 1
      if (repeat > 1) {
        const caseIds = [...new Set(results.map((r) => r.caseId))];
        for (const cid of caseIds) {
          const caseResults = results.filter((r) => r.caseId === cid);
          const passCount = caseResults.filter((r) => r.passed).length;
          const passRate = ((passCount / caseResults.length) * 100).toFixed(1);
          console.log(`\n${cid}: ${passCount}/${caseResults.length} passed (${passRate}%)`);
        }
      }

      if (!allPassed) {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof EvalError) {
        console.error(`Error: ${error.message}`);
      } else if (error instanceof Error) {
        console.error("Unexpected error:", error.message);
      } else {
        console.error("Unexpected error:", error);
      }
      process.exit(1);
    }
  } else {
    console.error(`Unknown subcommand: ${subcommand}`);
    printUsage();
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

function printLedgerUsage(): void {
  console.log(`
Usage: ca review ledger --run <run-id>

Options:
  --run <run-id>  Run ID from prepare step
  --json          Output summary as JSON
  --help          Show this help message

Example:
  ca review ledger --run abc123
`);
}

function printStageUsage(): void {
  console.log(`
Usage: ca review stage --run <run-id> --stage <stage> --engine <engine>

Options:
  --run <run-id>      Run ID from prepare step
  --stage <stage>     Stage to run (change-map, behavior-review, test-review, evidence-audit, synthesis)
  --engine <engine>   Engine to use (currently only claude)
  --help              Show this help message

Example:
  ca review stage --run abc123 --stage change-map --engine claude
  ca review stage --run abc123 --stage behavior-review --engine claude
  ca review stage --run abc123 --stage test-review --engine claude
  ca review stage --run abc123 --stage evidence-audit --engine claude
  ca review stage --run abc123 --stage synthesis --engine claude
`);
}

function printValidateUsage(): void {
  console.log(`
Usage: ca review validate --run <run-id>

Options:
  --run <run-id>  Run ID from prepare step
  --help          Show this help message

Example:
  ca review validate --run abc123
`);
}

function printReportUsage(): void {
  console.log(`
Usage: ca review report --run <run-id>

Options:
  --run <run-id>  Run ID from prepare step
  --help          Show this help message

Example:
  ca review report --run abc123
`);
}

function printRunUsage(): void {
  console.log(`
Usage: ca review run --base <ref> --head <ref> --engine claude --dry-run

Options:
  --base <ref>    Base git reference (e.g., origin/main)
  --head <ref>    Head git reference (e.g., HEAD)
  --engine <engine>  Engine to use (currently only claude)
  --dry-run       Run in dry-run mode (required)
  --help          Show this help message

Example:
  ca review run --base origin/main --head HEAD --engine claude --dry-run
`);
}

function printEvalUsage(): void {
  console.log(`
Usage: ca eval run --case <case-id> --engine claude [--repeat <n>]
       ca eval run --all --engine claude [--repeat <n>]

Options:
  --case <case-id>  Run a specific case
  --all             Run all cases
  --engine <engine> Engine to use (currently only claude)
  --repeat <n>      Repeat each case n times (default: 1)
  --help            Show this help message

Example:
  ca eval run --case case-001-error-state-not-restored --engine claude
  ca eval run --all --engine claude --repeat 3
`);
}
