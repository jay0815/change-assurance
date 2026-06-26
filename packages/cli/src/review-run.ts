import { reviewPrepare } from "./review-prepare.js";
import { reviewVerify } from "./review-verify.js";
import { reviewStage } from "./review-stage.js";
import { generateLedgers } from "./review-ledger.js";
import { reviewValidate } from "./review-validate.js";
import { reviewReport } from "./review-report.js";

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

export interface ReviewRunResult {
  runId: string;
  status: "completed" | "blocked" | "invalidated" | "failed";
  finalDecision?: string;
  reportPath?: string;
  summaryPath: string;
}

const STAGE_ORDER = ["change-map", "behavior-review", "test-review", "evidence-audit"];

export async function reviewRun(options: RunOptions): Promise<ReviewRunResult> {
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

  // Try prepare
  try {
    const base = options.base ?? "origin/main";
    const head = options.head ?? "HEAD";
    const { runId } = reviewPrepare({ base, head });

    // Try verify
    const verificationLedger = reviewVerify({ runId });
    if (verificationLedger.runStatus === "blocked" || verificationLedger.runStatus === "invalidated") {
      return {
        runId,
        status: verificationLedger.runStatus,
        summaryPath: "",
      };
    }

    // Run stages
    for (const stage of STAGE_ORDER) {
      try {
        await reviewStage({ runId, stage: stage as any, adapter: options.adapter });
      } catch (error) {
        return {
          runId,
          status: "failed",
          summaryPath: "",
        };
      }
    }

    // Generate ledgers
    try {
      generateLedgers({ runId });
    } catch (error) {
      return {
        runId,
        status: "failed",
        summaryPath: "",
      };
    }

    // Run synthesis (requires ledgers)
    try {
      await reviewStage({ runId, stage: "synthesis", adapter: options.adapter });
    } catch (error) {
      return {
        runId,
        status: "failed",
        summaryPath: "",
      };
    }

    // Validate
    let validationResult;
    try {
      validationResult = reviewValidate({ runId });
      if (validationResult.status !== "valid") {
        return {
          runId,
          status: validationResult.status as "blocked" | "invalidated",
          summaryPath: "",
        };
      }
    } catch (error) {
      return {
        runId,
        status: "failed",
        summaryPath: "",
      };
    }

    // Report
    let reportResult;
    try {
      reportResult = reviewReport({ runId });
    } catch (error) {
      return {
        runId,
        status: "failed",
        summaryPath: "",
      };
    }

    // Determine final decision
    const hasVerificationFailures = verificationLedger.summary.failed > 0;
    const finalDecision = hasVerificationFailures ? "not_ready_to_merge" : (validationResult.finalDecision ?? "ready_to_merge");

    return {
      runId,
      status: "completed",
      finalDecision,
      reportPath: reportResult.reportMarkdownPath,
      summaryPath: "",
    };
  } catch (error) {
    return {
      runId: "unknown",
      status: "failed",
      summaryPath: "",
    };
  }
}
