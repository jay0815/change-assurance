import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  getValidationResultPath,
  getReportDir,
  getReportMarkdownPath,
  getReportJsonPath,
  getStagesDir,
  getLedgersDir,
} from "@change-assurance/core";
import type {
  ValidationResult,
  Synthesis,
  IssueLedger,
  CoverageLedger,
  ReviewReport,
  ReviewReportIssue,
} from "@change-assurance/core";

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

export interface ReportInput {
  runId: string;
}

export interface ReportOutput {
  reportMarkdownPath: string;
  reportJsonPath: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function reviewReport(input: ReportInput): ReportOutput {
  const { runId } = input;
  const cwd = process.cwd();
  const validationPath = resolve(cwd, getValidationResultPath(runId));

  if (!existsSync(validationPath)) {
    throw new ReportError("validation-result.json not found. Run `ca review validate` first.");
  }

  const validation = readJsonSafe<ValidationResult>(validationPath);
  if (!validation) {
    throw new ReportError("validation-result.json is invalid");
  }

  if (validation.status !== "valid") {
    return generateDiagnosticReport(cwd, runId, validation);
  }

  return generateFullReport(cwd, runId, validation);
}

function generateDiagnosticReport(cwd: string, runId: string, validation: ValidationResult): ReportOutput {
  const report: ReviewReport = {
    runId,
    createdAt: new Date().toISOString(),
    status: validation.status,
    finalDecision: null,
    recommendationRationale: "",
    issues: { blocking: [], material: [], advisory: [], needsContext: [] },
    verificationSummary: { passed: 0, failed: 0, skipped: 0, notRequired: 0, note: "" },
    coverageSummary: { reviewed: 0, toolVerified: 0, uncovered: 0, needsContext: 0 },
    uncoveredAreas: [],
    sourceArtifacts: validation.sourceArtifacts,
    errors: validation.errors,
    warnings: validation.warnings,
  };

  const md = buildDiagnosticMarkdown(validation);
  return writeReport(cwd, runId, report, md);
}

function generateFullReport(cwd: string, runId: string, validation: ValidationResult): ReportOutput {
  const stagesDir = resolve(cwd, getStagesDir(runId));
  const ledgersDir = resolve(cwd, getLedgersDir(runId));

  // Read synthesis
  const synthesisPath = resolve(stagesDir, "synthesis.json");
  const synthesis = readJsonSafe<Synthesis>(synthesisPath);

  // Read issue-ledger
  const issueLedgerPath = resolve(ledgersDir, "issue-ledger.json");
  const issueLedger = readJsonSafe<IssueLedger>(issueLedgerPath);

  // Read coverage-ledger
  const coverageLedgerPath = resolve(ledgersDir, "coverage-ledger.json");
  const coverageLedger = readJsonSafe<CoverageLedger>(coverageLedgerPath);

  // Re-verify hashes match validation
  const reverifyPaths: Array<[string, string]> = [
    ["stages/synthesis.json", synthesisPath],
    ["ledgers/issue-ledger.json", issueLedgerPath],
    ["ledgers/coverage-ledger.json", coverageLedgerPath],
  ];
  for (const [artifactRelPath, absPath] of reverifyPaths) {
    if (existsSync(absPath)) {
      const actualHash = sha256(readFileSync(absPath, "utf-8"));
      const validationArtifact = validation.sourceArtifacts.find((a) => a.path === artifactRelPath);
      if (validationArtifact && validationArtifact.hash !== actualHash) {
        throw new ReportError(`${artifactRelPath} hash changed since validation. Re-run validate.`);
      }
    }
  }

  // Build issue groups by impact
  const issues = categorizeIssues(issueLedger);

  // Build uncovered areas
  const uncoveredAreas = (coverageLedger?.items ?? [])
    .filter((item) => item.status === "uncovered" || item.status === "needs_context")
    .map((item) => ({
      coverageItemId: item.id,
      area: item.area,
      status: item.status as "uncovered" | "needs_context",
      reason: item.reason,
    }));

  const report: ReviewReport = {
    runId,
    createdAt: new Date().toISOString(),
    status: validation.status,
    finalDecision: validation.finalDecision,
    recommendationRationale: synthesis?.recommendationRationale ?? "",
    issues,
    verificationSummary: synthesis?.verificationSummary ?? { passed: 0, failed: 0, skipped: 0, notRequired: 0, note: "" },
    coverageSummary: coverageLedger?.summary ?? { reviewed: 0, toolVerified: 0, uncovered: 0, needsContext: 0 },
    uncoveredAreas,
    sourceArtifacts: validation.sourceArtifacts,
    errors: validation.errors,
    warnings: validation.warnings,
  };

  const md = buildFullMarkdown(report, synthesis, issueLedger);
  return writeReport(cwd, runId, report, md);
}

function categorizeIssues(issueLedger: IssueLedger | null): ReviewReport["issues"] {
  const result: ReviewReport["issues"] = { blocking: [], material: [], advisory: [], needsContext: [] };
  if (!issueLedger) return result;

  for (const issue of issueLedger.issues) {
    const reportIssue: ReviewReportIssue = {
      id: issue.id,
      title: issue.title,
      candidateImpact: issue.candidateImpact,
      status: issue.status,
      summary: issue.summary,
    };
    switch (issue.candidateImpact) {
      case "merge_blocking":
        result.blocking.push(reportIssue);
        break;
      case "material":
        result.material.push(reportIssue);
        break;
      case "advisory":
        result.advisory.push(reportIssue);
        break;
      case "needs_context":
        result.needsContext.push(reportIssue);
        break;
    }
  }
  return result;
}

function buildDiagnosticMarkdown(validation: ValidationResult): string {
  const lines: string[] = [];
  lines.push("# Code Review Report");
  lines.push("");
  lines.push(`**Run ID:** ${validation.runId}`);
  lines.push(`**Status:** ${validation.status.toUpperCase()}`);
  lines.push(`**Final Decision:** unavailable`);
  lines.push("");

  if (validation.errors.length > 0) {
    lines.push("## Errors");
    lines.push("");
    for (const err of validation.errors) {
      lines.push(`- **${err.code}:** ${err.message}`);
    }
    lines.push("");
  }

  lines.push("## Required Action");
  lines.push("");
  if (validation.status === "blocked") {
    lines.push("Complete the missing steps in the review pipeline and re-run validate.");
  } else {
    lines.push("Artifact chain integrity compromised. Re-run prepare, ledger, and synthesis, then validate again.");
  }
  lines.push("");

  return lines.join("\n");
}

function buildFullMarkdown(report: ReviewReport, synthesis: Synthesis | null, _issueLedger: IssueLedger | null): string {
  const lines: string[] = [];
  lines.push("# Code Review Report");
  lines.push("");
  lines.push(`**Run ID:** ${report.runId}`);
  lines.push(`**Status:** VALID`);
  lines.push(`**Final Decision:** ${report.finalDecision}`);
  lines.push("");

  if (report.recommendationRationale) {
    lines.push("## Recommendation Rationale");
    lines.push("");
    lines.push(report.recommendationRationale);
    lines.push("");
  }

  // Issues by impact
  const allIssues = [
    ...report.issues.blocking.map((i) => ({ ...i, impactLabel: "Blocking" })),
    ...report.issues.material.map((i) => ({ ...i, impactLabel: "Material" })),
    ...report.issues.advisory.map((i) => ({ ...i, impactLabel: "Advisory" })),
    ...report.issues.needsContext.map((i) => ({ ...i, impactLabel: "Needs Context" })),
  ];

  if (allIssues.length > 0) {
    lines.push("## Issues");
    lines.push("");
    for (const issue of allIssues) {
      lines.push(`### [${issue.impactLabel}] ${issue.title}`);
      lines.push("");
      lines.push(`- **ID:** ${issue.id}`);
      lines.push(`- **Status:** ${issue.status}`);
      lines.push(`- **Summary:** ${issue.summary}`);
      lines.push("");
    }
  }

  // Issue groups
  if (synthesis?.issueGroups && synthesis.issueGroups.length > 0) {
    lines.push("## Issue Groups");
    lines.push("");
    for (const group of synthesis.issueGroups) {
      lines.push(`### ${group.title}`);
      lines.push("");
      lines.push(`- **Issues:** ${group.issueIds.join(", ")}`);
      lines.push(`- **Summary:** ${group.summary}`);
      lines.push("");
    }
  }

  // Verification summary
  lines.push("## Verification Summary");
  lines.push("");
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Passed | ${report.verificationSummary.passed} |`);
  lines.push(`| Failed | ${report.verificationSummary.failed} |`);
  lines.push(`| Skipped | ${report.verificationSummary.skipped} |`);
  lines.push(`| Not Required | ${report.verificationSummary.notRequired} |`);
  if (report.verificationSummary.note) {
    lines.push("");
    lines.push(`**Note:** ${report.verificationSummary.note}`);
  }
  lines.push("");

  // Coverage summary
  lines.push("## Coverage Summary");
  lines.push("");
  lines.push(`| Status | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Reviewed | ${report.coverageSummary.reviewed} |`);
  lines.push(`| Tool Verified | ${report.coverageSummary.toolVerified} |`);
  lines.push(`| Uncovered | ${report.coverageSummary.uncovered} |`);
  lines.push(`| Needs Context | ${report.coverageSummary.needsContext} |`);
  lines.push("");

  // Uncovered areas
  if (report.uncoveredAreas.length > 0) {
    lines.push("## Uncovered / Needs Context Areas");
    lines.push("");
    for (const area of report.uncoveredAreas) {
      lines.push(`- **[${area.status}]** ${area.area}: ${area.reason}`);
    }
    lines.push("");
  }

  // Warnings
  if (report.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const w of report.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push("");
  }

  // Source artifacts
  lines.push("## Source Artifacts");
  lines.push("");
  for (const artifact of report.sourceArtifacts) {
    lines.push(`- \`${artifact.path}\` — \`${artifact.hash.substring(0, 12)}\``);
  }
  lines.push("");

  return lines.join("\n");
}

function writeReport(cwd: string, runId: string, report: ReviewReport, markdown: string): ReportOutput {
  const reportDir = resolve(cwd, getReportDir(runId));
  mkdirSync(reportDir, { recursive: true });

  const markdownPath = resolve(cwd, getReportMarkdownPath(runId));
  const jsonPath = resolve(cwd, getReportJsonPath(runId));

  writeFileSync(markdownPath, markdown);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  return { reportMarkdownPath: markdownPath, reportJsonPath: jsonPath };
}
