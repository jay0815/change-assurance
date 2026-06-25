#!/usr/bin/env node

import { reviewPrepare, PrepareError } from "./review-prepare.js";
import { GitError } from "@change-assurance/core";

function printUsage(): void {
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

function parseArgs(args: string[]): { base?: string; head?: string } {
  const result: { base?: string; head?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base" && args[i + 1]) {
      result.base = args[++i];
    } else if (args[i] === "--head" && args[i + 1]) {
      result.head = args[++i];
    }
  }
  return result;
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  printUsage();
  process.exit(0);
}

const { base, head } = parseArgs(args);

if (!base || !head) {
  console.error("Error: --base and --head are required");
  printUsage();
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
