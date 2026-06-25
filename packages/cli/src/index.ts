#!/usr/bin/env node

import { reviewPrepare, PrepareError } from "./review-prepare.js";
import { reviewVerify, VerifyError } from "./review-verify.js";
import { GitError } from "@change-assurance/core";

function printUsage(): void {
  console.log(`
Usage: ca <command> [options]

Commands:
  review prepare    Prepare a review run
  review verify     Verify a review run

Options:
  --help            Show this help message

Prepare:
  ca review prepare --base <ref> --head <ref>

Verify:
  ca review verify --run <run-id>
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
