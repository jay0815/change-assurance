import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  getInputDir,
  getLedgersDir,
  getIssueLedgerPath,
  getCoverageLedgerPath,
  getVerificationLedgerPath,
} from "@change-assurance/core";
import type {
  ChangeMap,
  BehaviorReview,
  TestReview,
  EvidenceAudit,
  IssueLedger,
  LedgerIssue,
  CoverageLedger,
  CoverageItem,
  VerificationLedger,
} from "@change-assurance/core";

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export interface GenerateLedgersInput {
  runId: string;
}

export interface GenerateLedgersOutput {
  issueLedgerPath: string;
  coverageLedgerPath: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function generateLedgers(input: GenerateLedgersInput): GenerateLedgersOutput {
  const { runId } = input;
  const cwd = process.cwd();
  const inputDir = resolve(cwd, getInputDir(runId));
  const runDir = resolve(cwd, `.change-assurance/runs/${runId}`);
  const stagesDir = resolve(runDir, "stages");

  if (!existsSync(inputDir)) {
    throw new LedgerError(`Run not found: ${runId}`);
  }

  // Read and validate prerequisites

  const changeMapPath = resolve(stagesDir, "change-map.json");
  const behaviorReviewPath = resolve(stagesDir, "behavior-review.json");
  const testReviewPath = resolve(stagesDir, "test-review.json");
  const evidenceAuditPath = resolve(stagesDir, "evidence-audit.json");

  for (const [name, path] of [
    ["change-map.json", changeMapPath],
    ["behavior-review.json", behaviorReviewPath],
    ["test-review.json", testReviewPath],
    ["evidence-audit.json", evidenceAuditPath],
  ] as const) {
    if (!existsSync(path)) {
      throw new LedgerError(`${name} not found. Run all stages first.`);
    }
  }

  const changeMapContent = readFileSync(changeMapPath, "utf-8");
  const behaviorReviewContent = readFileSync(behaviorReviewPath, "utf-8");
  const testReviewContent = readFileSync(testReviewPath, "utf-8");
  const evidenceAuditContent = readFileSync(evidenceAuditPath, "utf-8");

  const changeMap = JSON.parse(changeMapContent) as ChangeMap;
  const behaviorReview = JSON.parse(behaviorReviewContent) as BehaviorReview;
  const testReview = JSON.parse(testReviewContent) as TestReview;
  const evidenceAudit = JSON.parse(evidenceAuditContent) as EvidenceAudit;

  // Validate hash consistency
  const evidenceAuditHash = sha256(evidenceAuditContent);
  const behaviorReviewHash = sha256(behaviorReviewContent);
  const testReviewHash = sha256(testReviewContent);
  const changeMapHash = sha256(changeMapContent);

  if (evidenceAudit.sourceArtifacts.behaviorReviewHash !== behaviorReviewHash) {
    throw new LedgerError("behavior-review.json hash mismatch with evidence-audit sourceArtifacts");
  }
  if (evidenceAudit.sourceArtifacts.testReviewHash !== testReviewHash) {
    throw new LedgerError("test-review.json hash mismatch with evidence-audit sourceArtifacts");
  }

  // Read verification ledger if available
  let verificationLedger: VerificationLedger | undefined;
  let verificationLedgerHash: string | undefined;
  const verificationLedgerPath = resolve(cwd, getVerificationLedgerPath(runId));
  if (existsSync(verificationLedgerPath)) {
    const vlContent = readFileSync(verificationLedgerPath, "utf-8");
    verificationLedger = JSON.parse(vlContent) as VerificationLedger;
    verificationLedgerHash = sha256(vlContent);
  }

  // Generate ledgers
  const ledgersDir = resolve(cwd, getLedgersDir(runId));
  mkdirSync(ledgersDir, { recursive: true });

  const issueLedger = buildIssueLedger(runId, evidenceAudit, behaviorReview, testReview, evidenceAuditHash, behaviorReviewHash, testReviewHash);
  const coverageLedger = buildCoverageLedger(runId, changeMap, behaviorReview, testReview, verificationLedger, changeMapHash, behaviorReviewHash, testReviewHash, verificationLedgerHash);

  // Validate before writing
  validateIssueLedger(issueLedger, evidenceAudit, behaviorReview, testReview);
  validateCoverageLedger(coverageLedger, changeMap);

  const issueLedgerPath = resolve(cwd, getIssueLedgerPath(runId));
  const coverageLedgerPath = resolve(cwd, getCoverageLedgerPath(runId));

  writeFileSync(issueLedgerPath, JSON.stringify(issueLedger, null, 2));
  writeFileSync(coverageLedgerPath, JSON.stringify(coverageLedger, null, 2));

  return { issueLedgerPath, coverageLedgerPath };
}

function buildIssueLedger(
  runId: string,
  audit: EvidenceAudit,
  br: BehaviorReview,
  tr: TestReview,
  evidenceAuditHash: string,
  behaviorReviewHash: string,
  testReviewHash: string,
): IssueLedger {
  // Build source finding lookup
  const brFindings = new Map(br.findings.map((f) => [f.id, f]));
  const trFindings = new Map(tr.findings.map((f) => [f.id, f]));

  // Track deduplicated finding IDs
  const deduplicatedRefs = new Set<string>();
  for (const af of audit.auditedFindings) {
    if (af.deduplicatedWith) {
      deduplicatedRefs.add(af.sourceFindingRef);
    }
  }

  const issues: LedgerIssue[] = [];

  for (const af of audit.auditedFindings) {
    // Skip rejected findings
    if (af.disposition === "rejected") continue;

    // Skip deduplicated findings (they point to another finding as primary)
    if (deduplicatedRefs.has(af.sourceFindingRef)) continue;

    // Find the source finding
    const sourceFinding = af.sourceStage === "behavior-review"
      ? brFindings.get(af.sourceFindingRef)
      : trFindings.get(af.sourceFindingRef);

    if (!sourceFinding) continue;

    const id = `issue-${af.sourceStage}-${af.sourceFindingRef}`;

    issues.push({
      id,
      sourceFindingRef: af.sourceFindingRef,
      sourceStage: af.sourceStage,
      status: af.disposition as "accepted" | "downgraded" | "needs_context",
      evidenceClass: af.evidenceClass,
      candidateImpact: af.effectiveCandidateImpact as "merge_blocking" | "material" | "advisory" | "needs_context",
      title: sourceFinding.title,
      summary: af.rationale,
      trigger: "trigger" in sourceFinding ? (sourceFinding as any).trigger : undefined,
      impact: sourceFinding.impact,
      recommendation: sourceFinding.recommendation,
      evidenceRefs: af.verifiedEvidenceRefs,
      missingEvidence: af.missingEvidence,
      missingContext: af.missingContext,
      deduplicatedWith: af.deduplicatedWith,
    });
  }

  const summary = {
    accepted: issues.filter((i) => i.status === "accepted").length,
    downgraded: issues.filter((i) => i.status === "downgraded").length,
    needsContext: issues.filter((i) => i.status === "needs_context").length,
    deduplicated: deduplicatedRefs.size,
  };

  return {
    runId,
    createdAt: new Date().toISOString(),
    sourceArtifacts: { evidenceAuditHash, behaviorReviewHash, testReviewHash },
    issues,
    summary,
  };
}

function buildCoverageLedger(
  runId: string,
  cm: ChangeMap,
  br: BehaviorReview,
  tr: TestReview,
  vl: VerificationLedger | undefined,
  changeMapHash: string,
  behaviorReviewHash: string,
  testReviewHash: string,
  verificationLedgerHash: string | undefined,
): CoverageLedger {
  const items: CoverageItem[] = [];
  let nextId = 1;

  // 1. behavior-review reviewed areas → reviewed
  for (const area of br.reviewedAreas) {
    items.push({
      id: `cov-${nextId++}`,
      area: area.area,
      paths: area.paths,
      status: "reviewed",
      sources: ["behavior-review"],
      evidenceRefs: area.evidenceRefs,
      reason: area.focus,
    });
  }

  // 2. test-review reviewed behaviors → reviewed or needs_context
  for (const rb of tr.reviewedBehaviors) {
    const existingItem = items.find((i) => i.area === rb.behavior);
    if (existingItem) {
      existingItem.sources.push("test-review");
      existingItem.evidenceRefs.push(...rb.implementationEvidenceRefs, ...rb.testEvidenceRefs);
      continue;
    }

    const status = rb.assessment === "needs_context" ? "needs_context" : "reviewed";
    items.push({
      id: `cov-${nextId++}`,
      area: rb.behavior,
      paths: [],
      status,
      sources: ["test-review"],
      evidenceRefs: [...rb.implementationEvidenceRefs, ...rb.testEvidenceRefs],
      reason: rb.rationale,
    });
  }

  // 3. verification passed commands → tool_verified
  if (vl) {
    for (const cmd of vl.commands) {
      if (cmd.status === "passed") {
        items.push({
          id: `cov-${nextId++}`,
          area: cmd.id,
          paths: [],
          status: "tool_verified",
          sources: ["verification"],
          evidenceRefs: [],
          reason: `Command passed: ${cmd.argv.join(" ")}`,
        });
      }
    }
  }

  // 4. change-map high/medium priority areas not covered → uncovered
  const coveredAreas = new Set(items.map((i) => i.area.toLowerCase()));
  for (const priority of cm.reviewPriorities) {
    if (priority.priority !== "high" && priority.priority !== "medium") continue;
    if (coveredAreas.has(priority.area.toLowerCase())) continue;

    items.push({
      id: `cov-${nextId++}`,
      area: priority.area,
      paths: [],
      status: "uncovered",
      sources: ["change-map"],
      evidenceRefs: [],
      reason: priority.reason,
    });
  }

  // 5. change-map uncoveredContext → needs_context
  for (const uc of cm.uncoveredContext) {
    items.push({
      id: `cov-${nextId++}`,
      area: uc.area,
      paths: [],
      status: "needs_context",
      sources: ["change-map"],
      evidenceRefs: [],
      reason: uc.reason,
    });
  }

  const summary = {
    reviewed: items.filter((i) => i.status === "reviewed").length,
    toolVerified: items.filter((i) => i.status === "tool_verified").length,
    uncovered: items.filter((i) => i.status === "uncovered").length,
    needsContext: items.filter((i) => i.status === "needs_context").length,
  };

  return {
    runId,
    createdAt: new Date().toISOString(),
    sourceArtifacts: { changeMapHash, behaviorReviewHash, testReviewHash, verificationLedgerHash },
    items,
    summary,
  };
}

function validateIssueLedger(
  ledger: IssueLedger,
  audit: EvidenceAudit,
  _br: BehaviorReview,
  _tr: TestReview,
): void {
  // Build verified evidence lookup from audit
  const auditVerifiedRefs = new Map<string, Set<string>>();
  for (const af of audit.auditedFindings) {
    auditVerifiedRefs.set(af.sourceFindingRef, new Set(af.verifiedEvidenceRefs ?? []));
  }

  for (const issue of ledger.issues) {
    // evidenceRefs must be subset of audit's verifiedEvidenceRefs
    const verified = auditVerifiedRefs.get(issue.sourceFindingRef);
    if (verified) {
      for (const ref of issue.evidenceRefs) {
        if (!verified.has(ref)) {
          throw new LedgerError(`Issue ${issue.id} references unverified evidence: ${ref}`);
        }
      }
    }
  }

  // Summary must match
  const expectedAccepted = ledger.issues.filter((i) => i.status === "accepted").length;
  const expectedDowngraded = ledger.issues.filter((i) => i.status === "downgraded").length;
  const expectedNeedsContext = ledger.issues.filter((i) => i.status === "needs_context").length;

  if (ledger.summary.accepted !== expectedAccepted) {
    throw new LedgerError(`summary.accepted mismatch: expected ${expectedAccepted}, got ${ledger.summary.accepted}`);
  }
  if (ledger.summary.downgraded !== expectedDowngraded) {
    throw new LedgerError(`summary.downgraded mismatch: expected ${expectedDowngraded}, got ${ledger.summary.downgraded}`);
  }
  if (ledger.summary.needsContext !== expectedNeedsContext) {
    throw new LedgerError(`summary.needsContext mismatch: expected ${expectedNeedsContext}, got ${ledger.summary.needsContext}`);
  }
}

function validateCoverageLedger(ledger: CoverageLedger, _cm: ChangeMap): void {
  // Summary must match
  const expectedReviewed = ledger.items.filter((i) => i.status === "reviewed").length;
  const expectedToolVerified = ledger.items.filter((i) => i.status === "tool_verified").length;
  const expectedUncovered = ledger.items.filter((i) => i.status === "uncovered").length;
  const expectedNeedsContext = ledger.items.filter((i) => i.status === "needs_context").length;

  if (ledger.summary.reviewed !== expectedReviewed) {
    throw new LedgerError(`coverage summary.reviewed mismatch: expected ${expectedReviewed}, got ${ledger.summary.reviewed}`);
  }
  if (ledger.summary.toolVerified !== expectedToolVerified) {
    throw new LedgerError(`coverage summary.toolVerified mismatch: expected ${expectedToolVerified}, got ${ledger.summary.toolVerified}`);
  }
  if (ledger.summary.uncovered !== expectedUncovered) {
    throw new LedgerError(`coverage summary.uncovered mismatch: expected ${expectedUncovered}, got ${ledger.summary.uncovered}`);
  }
  if (ledger.summary.needsContext !== expectedNeedsContext) {
    throw new LedgerError(`coverage summary.needsContext mismatch: expected ${expectedNeedsContext}, got ${ledger.summary.needsContext}`);
  }

  // reviewed must have evidence
  for (const item of ledger.items) {
    if (item.status === "reviewed" && item.sources.length === 0) {
      throw new LedgerError(`Coverage item ${item.id} is reviewed but has no sources`);
    }
    if ((item.status === "uncovered" || item.status === "needs_context") && !item.reason) {
      throw new LedgerError(`Coverage item ${item.id} is ${item.status} but has no reason`);
    }
  }
}
