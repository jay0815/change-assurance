export interface InputManifest {
  runId: string;
  baseRef: string;
  headRef: string;
  createdAt: string;
  policySnapshotHash: string;
  diffHash: string;
  changedFilesHash: string;
  gitStateHash: string;
}

export interface GitState {
  baseRef: string;
  headRef: string;
  baseCommit: string;
  headCommit: string;
  branch: string;
  isDirty: boolean;
  timestamp: string;
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  oldPath?: string;
}

export interface ReviewRun {
  runId: string;
  baseRef: string;
  headRef: string;
  createdAt: string;
  status: "created" | "verified" | "reviewed" | "completed";
}

// Policy types
export interface PolicyConfig {
  version: number;
  review?: {
    defaultBaseRef?: string;
  };
  scope?: {
    ignore?: string[];
  };
  verification?: {
    commands?: VerificationCommandPolicy[];
  };
  decision?: {
    requireExecutedVerificationEvidence?: boolean;
  };
}

export interface VerificationCommandPolicy {
  id: string;
  argv: string[];
  when?: {
    pathsAny?: string[];
  };
}

// Verification types
export type VerificationStatus = "passed" | "failed" | "skipped" | "not_required";

export interface VerificationCommandResult {
  id: string;
  argv: string[];
  required: boolean;
  status: VerificationStatus;
  selectionReason: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  exitCode?: number;
  stdoutPath?: string;
  stderrPath?: string;
  skipReason?: string;
}

export interface VerificationLedger {
  runId: string;
  createdAt: string;
  runStatus: "completed" | "blocked" | "invalidated";
  policySnapshotHash: string;
  preconditionErrors: string[];
  commands: VerificationCommandResult[];
  summary: {
    passed: number;
    failed: number;
    skipped: number;
    notRequired: number;
  };
  workspaceChangedAfterVerify: boolean;
}

// Stage types
export type ReviewStage = "change-map" | "behavior-review" | "test-review" | "evidence-audit" | "synthesis";

export interface ChangedModule {
  path: string;
  role: string;
  changeSummary: string;
}

export interface BehaviorChange {
  summary: string;
  evidenceRefs: string[];
}

export interface RiskArea {
  area: string;
  reason: string;
  evidenceRefs: string[];
}

export interface ReviewPriority {
  priority: "high" | "medium" | "low";
  area: string;
  reason: string;
}

export interface UncoveredContext {
  area: string;
  reason: string;
}

export interface ChangeMap {
  runId: string;
  stage: "change-map";
  createdAt: string;
  sourceArtifacts: {
    inputManifestHash: string;
    policySnapshotHash: string;
    verificationLedgerHash?: string;
  };
  changedModules: ChangedModule[];
  behaviorChanges: BehaviorChange[];
  riskAreas: RiskArea[];
  reviewPriorities: ReviewPriority[];
  uncoveredContext: UncoveredContext[];
  assumptions: string[];
}

export interface ReviewedArea {
  area: string;
  paths: string[];
  focus: string;
  evidenceRefs: string[];
}

export interface BehaviorFinding {
  id: string;
  title: string;
  type: "success_path" | "failure_path" | "state_transition" | "boundary_condition" | "regression_risk";
  candidateImpact: "merge_blocking" | "material" | "advisory";
  trigger: string;
  observedBehavior: string;
  expectedBehavior?: string;
  impact: string;
  recommendation: string;
  evidenceRefs: string[];
  confidence: "high" | "medium" | "low";
}

export interface BehaviorReview {
  runId: string;
  stage: "behavior-review";
  createdAt: string;
  sourceArtifacts: {
    inputManifestHash: string;
    changeMapHash: string;
    verificationLedgerHash?: string;
  };
  reviewedAreas: ReviewedArea[];
  findings: BehaviorFinding[];
  uncoveredContext: UncoveredContext[];
  assumptions: string[];
}

export interface ReviewedBehavior {
  behavior: string;
  implementationEvidenceRefs: string[];
  testEvidenceRefs: string[];
  assessment: "adequately_covered" | "partially_covered" | "not_covered" | "not_applicable" | "needs_context";
  rationale: string;
}

export interface TestFinding {
  id: string;
  title: string;
  type: "missing_test" | "missing_failure_path_test" | "weak_assertion" | "test_contract_gap" | "test_execution_gap";
  candidateImpact: "material" | "advisory" | "needs_context";
  behavior: string;
  observedTestCoverage: string;
  impact: string;
  recommendation: string;
  evidenceRefs: string[];
  confidence: "high" | "medium" | "low";
}

export interface TestReview {
  runId: string;
  stage: "test-review";
  createdAt: string;
  sourceArtifacts: {
    inputManifestHash: string;
    changeMapHash: string;
    behaviorReviewHash: string;
    verificationLedgerHash?: string;
  };
  reviewedBehaviors: ReviewedBehavior[];
  findings: TestFinding[];
  verificationAssessment: {
    testCommandStatus: "passed" | "failed" | "not_required" | "unavailable";
    note: string;
  };
  uncoveredContext: UncoveredContext[];
  assumptions: string[];
}

export type EvidenceClass = "observed" | "derived" | "hypothesis";
export type AuditDisposition = "accepted" | "downgraded" | "needs_context" | "rejected";

export interface AuditedFinding {
  sourceFindingRef: string;
  sourceStage: "behavior-review" | "test-review";
  disposition: AuditDisposition;
  evidenceClass: EvidenceClass;
  effectiveCandidateImpact: "merge_blocking" | "material" | "advisory" | "needs_context" | null;
  rationale: string;
  verifiedEvidenceRefs: string[];
  missingEvidence: string[];
  missingContext: string[];
  deduplicatedWith?: string;
}

export interface EvidenceAudit {
  runId: string;
  stage: "evidence-audit";
  createdAt: string;
  sourceArtifacts: {
    inputManifestHash: string;
    changeMapHash: string;
    behaviorReviewHash: string;
    testReviewHash: string;
    verificationLedgerHash?: string;
  };
  auditedFindings: AuditedFinding[];
  summary: {
    accepted: number;
    downgraded: number;
    needsContext: number;
    rejected: number;
  };
  assumptions: string[];
}

// Ledger types

export type LedgerIssueStatus = "accepted" | "downgraded" | "needs_context";

export interface LedgerIssue {
  id: string;
  sourceFindingRef: string;
  sourceStage: "behavior-review" | "test-review";
  status: LedgerIssueStatus;
  evidenceClass: "observed" | "derived" | "hypothesis";
  candidateImpact: "merge_blocking" | "material" | "advisory" | "needs_context";
  title: string;
  summary: string;
  trigger?: string;
  impact: string;
  recommendation: string;
  evidenceRefs: string[];
  missingEvidence: string[];
  missingContext: string[];
  deduplicatedWith?: string;
}

export interface IssueLedger {
  runId: string;
  createdAt: string;
  sourceArtifacts: {
    evidenceAuditHash: string;
    behaviorReviewHash: string;
    testReviewHash: string;
  };
  issues: LedgerIssue[];
  summary: {
    accepted: number;
    downgraded: number;
    needsContext: number;
    deduplicated: number;
  };
}

export type CoverageStatus = "reviewed" | "tool_verified" | "uncovered" | "needs_context";

export interface CoverageItem {
  id: string;
  area: string;
  paths: string[];
  status: CoverageStatus;
  sources: Array<"change-map" | "behavior-review" | "test-review" | "verification">;
  evidenceRefs: string[];
  reason: string;
}

export interface CoverageLedger {
  runId: string;
  createdAt: string;
  sourceArtifacts: {
    changeMapHash: string;
    behaviorReviewHash: string;
    testReviewHash: string;
    verificationLedgerHash?: string;
  };
  items: CoverageItem[];
  summary: {
    reviewed: number;
    toolVerified: number;
    uncovered: number;
    needsContext: number;
  };
}

// Synthesis types

export type MergeRecommendation =
  | "ready_to_merge"
  | "not_ready_to_merge"
  | "insufficient_evidence"
  | "escalate";

export interface IssueGroup {
  title: string;
  issueIds: string[];
  summary: string;
}

export interface Synthesis {
  runId: string;
  stage: "synthesis";
  createdAt: string;
  sourceArtifacts: {
    issueLedgerHash: string;
    coverageLedgerHash: string;
    verificationLedgerHash?: string;
  };
  recommendation: MergeRecommendation;
  recommendationRationale: string;
  issueGroups: IssueGroup[];
  verificationSummary: {
    passed: number;
    failed: number;
    skipped: number;
    notRequired: number;
    note: string;
  };
  uncoveredSummary: Array<{
    coverageItemId: string;
    status: "uncovered" | "needs_context";
    summary: string;
  }>;
  assumptions: string[];
}

// Validation types

export type ValidationStatus = "valid" | "blocked" | "invalidated";

export interface ValidationSourceArtifact {
  path: string;
  hash: string;
}

export interface ValidationError {
  code: string;
  message: string;
  artifactPath?: string;
}

export interface ValidationResult {
  runId: string;
  createdAt: string;
  status: ValidationStatus;
  finalDecision: MergeRecommendation | null;
  sourceArtifacts: ValidationSourceArtifact[];
  errors: ValidationError[];
  warnings: string[];
}

// Report types

export interface ReviewReportIssue {
  id: string;
  title: string;
  candidateImpact: string;
  status: string;
  summary: string;
}

export interface ReviewReport {
  runId: string;
  createdAt: string;
  status: ValidationStatus;
  finalDecision: MergeRecommendation | null;
  recommendationRationale: string;
  issues: {
    blocking: ReviewReportIssue[];
    material: ReviewReportIssue[];
    advisory: ReviewReportIssue[];
    needsContext: ReviewReportIssue[];
  };
  verificationSummary: {
    passed: number;
    failed: number;
    skipped: number;
    notRequired: number;
    note: string;
  };
  coverageSummary: {
    reviewed: number;
    toolVerified: number;
    uncovered: number;
    needsContext: number;
  };
  uncoveredAreas: Array<{
    coverageItemId: string;
    area: string;
    status: "uncovered" | "needs_context";
    reason: string;
  }>;
  sourceArtifacts: ValidationSourceArtifact[];
  errors: ValidationError[];
  warnings: string[];
}
