#!/usr/bin/env node

import { reviewPrepare, PrepareError } from "./review-prepare.js";
import { reviewVerify, VerifyError } from "./review-verify.js";
import { reviewStage, StageError } from "./review-stage.js";
import { generateLedgers, LedgerError } from "./review-ledger.js";
import { ClaudeAdapter, AdapterError } from "@change-assurance/adapter-claude";
import { GitError } from "@change-assurance/core";

function printUsage(): void {
  console.log(`
Usage: ca <command> [options]

Commands:
  review prepare    Prepare a review run
  review verify     Verify a review run
  review stage      Run a review stage
  review ledger     Generate issue and coverage ledgers

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

        console.log(`\nLedger: .change-assurance/runs/${runId}/verification/verification-ledger.json`);
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

    if (stage !== "change-map" && stage !== "behavior-review" && stage !== "test-review" && stage !== "evidence-audit") {
      console.error(`Error: Unsupported stage: ${stage}. Supported: change-map, behavior-review, test-review, evidence-audit.`);
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
        console.log(JSON.stringify({ issueLedger: issueLedger.summary, coverageLedger: coverageLedger.summary }, null, 2));
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
  --stage <stage>     Stage to run (change-map, behavior-review, test-review, evidence-audit)
  --engine <engine>   Engine to use (currently only claude)
  --help              Show this help message

Example:
  ca review stage --run abc123 --stage change-map --engine claude
  ca review stage --run abc123 --stage behavior-review --engine claude
  ca review stage --run abc123 --stage test-review --engine claude
  ca review stage --run abc123 --stage evidence-audit --engine claude
`);
}
