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
export type ReviewStage = "change-map" | "behavior-review" | "test-review";

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
