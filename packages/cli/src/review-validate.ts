import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  getInputDir,
  getStagesDir,
  getLedgersDir,
  getVerificationDir,
  getValidationDir,
  getValidationResultPath,
  INPUT_ARTIFACTS,
  getHeadCommit,
  isWorkingTreeDirty,
} from "@change-assurance/core";
import type {
  InputManifest,
  ValidationResult,
  ValidationSourceArtifact,
  ValidationError,
} from "@change-assurance/core";

export class ValidateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidateError";
  }
}

export interface ValidateInput {
  runId: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readJsonSafe(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function checkWorkspaceClean(): { dirty: boolean; onlyChangeAssurance: boolean } {
  try {
    if (!isWorkingTreeDirty()) return { dirty: false, onlyChangeAssurance: false };
    // If dirty, check if only .change-assurance/ files changed
    try {
      const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf-8" });
      const lines = status.split("\n").filter((line: string) => line.trim());
      const nonIgnored = lines.filter((line: string) => !line.includes(".change-assurance/"));
      return { dirty: true, onlyChangeAssurance: nonIgnored.length === 0 };
    } catch {
      // git not available but isWorkingTreeDirty reported dirty
      return { dirty: true, onlyChangeAssurance: false };
    }
  } catch {
    return { dirty: false, onlyChangeAssurance: false };
  }
}

export function reviewValidate(input: ValidateInput): ValidationResult {
  const { runId } = input;
  const cwd = process.cwd();
  const runDir = resolve(cwd, ".change-assurance", "runs", runId);
  const inputDir = resolve(cwd, getInputDir(runId));
  const stagesDir = resolve(cwd, getStagesDir(runId));
  const ledgersDir = resolve(cwd, getLedgersDir(runId));
  const verificationDir = resolve(cwd, getVerificationDir(runId));

  const errors: ValidationError[] = [];
  const warnings: string[] = [];
  const sourceArtifacts: ValidationSourceArtifact[] = [];

  function recordArtifact(relPath: string): void {
    const absPath = resolve(runDir, relPath);
    if (existsSync(absPath)) {
      sourceArtifacts.push({ path: relPath, hash: sha256(readFileSync(absPath, "utf-8")) });
    }
  }

  // 1. Check run exists
  if (!existsSync(inputDir)) {
    const result: ValidationResult = {
      runId, createdAt: new Date().toISOString(),
      status: "blocked", finalDecision: null,
      sourceArtifacts: [], errors: [{ code: "MISSING_RUN", message: `Run not found: ${runId}` }], warnings: [],
    };
    writeResult(cwd, runId, result);
    return result;
  }

  // 2. Read and validate input manifest
  const manifestPath = resolve(inputDir, INPUT_ARTIFACTS.INPUT_MANIFEST);
  if (!existsSync(manifestPath)) {
    errors.push({ code: "MISSING_MANIFEST", message: "input-manifest.json not found", artifactPath: manifestPath });
  }

  const manifest = existsSync(manifestPath) ? readJsonSafe(manifestPath) as InputManifest : null;
  if (!manifest) {
    errors.push({ code: "INVALID_MANIFEST", message: "input-manifest.json is invalid" });
  }

  // 3. Validate input artifact hashes
  if (manifest) {
    const inputChecks: Array<[string, string, string]> = [
      [INPUT_ARTIFACTS.DIFF_PATCH, manifest.diffHash, "diff.patch"],
      [INPUT_ARTIFACTS.CHANGED_FILES, manifest.changedFilesHash, "changed-files.json"],
      [INPUT_ARTIFACTS.GIT_STATE, manifest.gitStateHash, "git-state.json"],
      [INPUT_ARTIFACTS.POLICY_SNAPSHOT, manifest.policySnapshotHash, "policy.snapshot.yaml"],
    ];
    for (const [filename, expectedHash, label] of inputChecks) {
      const filePath = resolve(inputDir, filename);
      if (!existsSync(filePath)) {
        errors.push({ code: "MISSING_INPUT", message: `${label} not found`, artifactPath: filePath });
        continue;
      }
      const content = readFileSync(filePath, "utf-8");
      const actualHash = sha256(content);
      sourceArtifacts.push({ path: `input/${filename}`, hash: actualHash });
      if (actualHash !== expectedHash) {
        errors.push({ code: "INPUT_HASH_MISMATCH", message: `${label} hash mismatch`, artifactPath: filePath });
      }
    }

    // 4. Check HEAD matches
    const gitStatePath = resolve(inputDir, INPUT_ARTIFACTS.GIT_STATE);
    if (existsSync(gitStatePath)) {
      const gitState = readJsonSafe(gitStatePath) as { headCommit?: string } | null;
      if (gitState?.headCommit) {
        const currentHead = getHeadCommit();
        if (currentHead !== gitState.headCommit) {
          errors.push({
            code: "HEAD_CHANGED",
            message: `HEAD changed: expected ${gitState.headCommit}, got ${currentHead}`,
          });
        }
      }
    }
  }

  // 5. Check workspace is clean
  const wsStatus = checkWorkspaceClean();
  if (wsStatus.dirty && !wsStatus.onlyChangeAssurance) {
    errors.push({
      code: "WORKSPACE_DIRTY",
      message: "Working tree has uncommitted changes outside .change-assurance/",
    });
  }

  // 6. Check stage artifacts exist
  const stageArtifacts = ["change-map.json", "behavior-review.json", "test-review.json", "evidence-audit.json"];
  for (const stageFile of stageArtifacts) {
    const stagePath = resolve(stagesDir, stageFile);
    if (!existsSync(stagePath)) {
      errors.push({ code: "MISSING_STAGE", message: `${stageFile} not found`, artifactPath: stagePath });
    } else {
      recordArtifact(`stages/${stageFile}`);
    }
  }

  // 7. Check ledgers exist
  const issueLedgerPath = resolve(ledgersDir, "issue-ledger.json");
  const coverageLedgerPath = resolve(ledgersDir, "coverage-ledger.json");
  if (!existsSync(issueLedgerPath)) {
    errors.push({ code: "MISSING_LEDGER", message: "issue-ledger.json not found", artifactPath: issueLedgerPath });
  } else {
    recordArtifact("ledgers/issue-ledger.json");
  }
  if (!existsSync(coverageLedgerPath)) {
    errors.push({ code: "MISSING_LEDGER", message: "coverage-ledger.json not found", artifactPath: coverageLedgerPath });
  } else {
    recordArtifact("ledgers/coverage-ledger.json");
  }

  // 8. Check synthesis exists
  const synthesisPath = resolve(stagesDir, "synthesis.json");
  if (!existsSync(synthesisPath)) {
    errors.push({ code: "MISSING_SYNTHESIS", message: "synthesis.json not found", artifactPath: synthesisPath });
  } else {
    recordArtifact("stages/synthesis.json");
  }

  // Record verification ledger
  const verificationLedgerPath = resolve(verificationDir, "verification-ledger.json");
  if (existsSync(verificationLedgerPath)) {
    recordArtifact("verification/verification-ledger.json");
  }

  // 9. Validate hash chain: ledger → stage artifacts
  if (existsSync(issueLedgerPath)) {
    const issueLedger = readJsonSafe(issueLedgerPath) as any;
    const eaPath = resolve(stagesDir, "evidence-audit.json");
    const brPath = resolve(stagesDir, "behavior-review.json");
    const trPath = resolve(stagesDir, "test-review.json");

    if (issueLedger?.sourceArtifacts) {
      if (existsSync(brPath)) {
        const brHash = sha256(readFileSync(brPath, "utf-8"));
        if (issueLedger.sourceArtifacts.behaviorReviewHash !== brHash) {
          errors.push({ code: "LEDGER_HASH_MISMATCH", message: "issue-ledger.behaviorReviewHash mismatch with current behavior-review.json" });
        }
      }
      if (existsSync(trPath)) {
        const trHash = sha256(readFileSync(trPath, "utf-8"));
        if (issueLedger.sourceArtifacts.testReviewHash !== trHash) {
          errors.push({ code: "LEDGER_HASH_MISMATCH", message: "issue-ledger.testReviewHash mismatch with current test-review.json" });
        }
      }
      if (existsSync(eaPath)) {
        const eaHash = sha256(readFileSync(eaPath, "utf-8"));
        if (issueLedger.sourceArtifacts.evidenceAuditHash !== eaHash) {
          errors.push({ code: "LEDGER_HASH_MISMATCH", message: "issue-ledger.evidenceAuditHash mismatch with current evidence-audit.json" });
        }
      }
    }
  }

  if (existsSync(coverageLedgerPath)) {
    const coverageLedger = readJsonSafe(coverageLedgerPath) as any;
    const cmPath = resolve(stagesDir, "change-map.json");
    const brPath = resolve(stagesDir, "behavior-review.json");
    const trPath = resolve(stagesDir, "test-review.json");

    if (coverageLedger?.sourceArtifacts) {
      if (existsSync(cmPath)) {
        const cmHash = sha256(readFileSync(cmPath, "utf-8"));
        if (coverageLedger.sourceArtifacts.changeMapHash !== cmHash) {
          errors.push({ code: "LEDGER_HASH_MISMATCH", message: "coverage-ledger.changeMapHash mismatch with current change-map.json" });
        }
      }
      if (existsSync(brPath)) {
        const brHash = sha256(readFileSync(brPath, "utf-8"));
        if (coverageLedger.sourceArtifacts.behaviorReviewHash !== brHash) {
          errors.push({ code: "LEDGER_HASH_MISMATCH", message: "coverage-ledger.behaviorReviewHash mismatch with current behavior-review.json" });
        }
      }
      if (existsSync(trPath)) {
        const trHash = sha256(readFileSync(trPath, "utf-8"));
        if (coverageLedger.sourceArtifacts.testReviewHash !== trHash) {
          errors.push({ code: "LEDGER_HASH_MISMATCH", message: "coverage-ledger.testReviewHash mismatch with current test-review.json" });
        }
      }
      if (existsSync(verificationLedgerPath) && coverageLedger.sourceArtifacts.verificationLedgerHash) {
        const vlHash = sha256(readFileSync(verificationLedgerPath, "utf-8"));
        if (coverageLedger.sourceArtifacts.verificationLedgerHash !== vlHash) {
          errors.push({ code: "LEDGER_HASH_MISMATCH", message: "coverage-ledger.verificationLedgerHash mismatch with current verification-ledger.json" });
        }
      }
    }
  }

  // 10. Validate synthesis → ledger hash chain
  if (existsSync(synthesisPath) && existsSync(issueLedgerPath) && existsSync(coverageLedgerPath)) {
    const synthesis = readJsonSafe(synthesisPath) as any;
    const issueLedgerContent = readFileSync(issueLedgerPath, "utf-8");
    const coverageLedgerContent = readFileSync(coverageLedgerPath, "utf-8");
    const issueLedgerForDecision = JSON.parse(issueLedgerContent) as any;

    if (!synthesis?.sourceArtifacts) {
      errors.push({ code: "MISSING_SYNTHESIS_ARTIFACTS", message: "synthesis.json missing sourceArtifacts — hash chain cannot be verified" });
    } else {
      if (synthesis.sourceArtifacts.issueLedgerHash !== sha256(issueLedgerContent)) {
        errors.push({ code: "SYNTHESIS_HASH_MISMATCH", message: "synthesis.issueLedgerHash mismatch with current issue-ledger.json" });
      }
      if (synthesis.sourceArtifacts.coverageLedgerHash !== sha256(coverageLedgerContent)) {
        errors.push({ code: "SYNTHESIS_HASH_MISMATCH", message: "synthesis.coverageLedgerHash mismatch with current coverage-ledger.json" });
      }
      if (existsSync(verificationLedgerPath) && synthesis.sourceArtifacts.verificationLedgerHash) {
        const vlHash = sha256(readFileSync(verificationLedgerPath, "utf-8"));
        if (synthesis.sourceArtifacts.verificationLedgerHash !== vlHash) {
          errors.push({ code: "SYNTHESIS_HASH_MISMATCH", message: "synthesis.verificationLedgerHash mismatch with current verification-ledger.json" });
        }
      }
    }

    // 11. Validate synthesis recommendation against constraints
    if (synthesis?.recommendation) {
      const hasBlocking = issueLedgerForDecision?.issues?.some((i: any) => i.candidateImpact === "merge_blocking") ?? false;
      const verificationLedger = existsSync(verificationLedgerPath) ? readJsonSafe(verificationLedgerPath) as any : null;
      const hasFailedVerification = verificationLedger?.commands?.some((c: any) => c.status === "failed") ?? false;

      if (hasBlocking && synthesis.recommendation === "ready_to_merge") {
        errors.push({ code: "DECISION_CONFLICT", message: "Synthesis recommends ready_to_merge but merge_blocking issues exist" });
      }
      if (hasFailedVerification && synthesis.recommendation === "ready_to_merge") {
        errors.push({ code: "DECISION_CONFLICT", message: "Synthesis recommends ready_to_merge but verification has failed commands" });
      }
    }
  }

  // Determine final status — integrity errors take priority over missing errors
  const hasIntegrityErrors = errors.some((e) =>
    e.code.includes("HASH_MISMATCH") || e.code === "HEAD_CHANGED" ||
    e.code === "WORKSPACE_DIRTY" || e.code === "DECISION_CONFLICT" ||
    e.code === "MISSING_SYNTHESIS_ARTIFACTS"
  );
  const hasMissingErrors = errors.some((e) =>
    e.code.startsWith("MISSING_") || e.code === "INVALID_MANIFEST"
  );

  let status: "valid" | "blocked" | "invalidated";
  if (hasIntegrityErrors) {
    status = "invalidated";
  } else if (hasMissingErrors) {
    status = "blocked";
  } else {
    status = "valid";
  }

  // Determine finalDecision
  let finalDecision: ValidationResult["finalDecision"] = null;
  if (status === "valid" && existsSync(synthesisPath)) {
    const synthesis = readJsonSafe(synthesisPath) as any;
    finalDecision = synthesis?.recommendation ?? null;
  }

  const result: ValidationResult = {
    runId, createdAt: new Date().toISOString(),
    status, finalDecision,
    sourceArtifacts, errors, warnings,
  };

  writeResult(cwd, runId, result);
  return result;
}

function writeResult(cwd: string, runId: string, result: ValidationResult): void {
  const validationDir = resolve(cwd, getValidationDir(runId));
  mkdirSync(validationDir, { recursive: true });
  const resultPath = resolve(cwd, getValidationResultPath(runId));
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
}
