import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reviewStage, StageError } from "../review-stage.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import * as core from "@change-assurance/core";

vi.mock("@change-assurance/core", async () => {
  const actual =
    await vi.importActual<typeof import("@change-assurance/core")>("@change-assurance/core");
  return {
    ...actual,
    getHeadCommit: vi.fn(),
    isWorkingTreeDirty: vi.fn(),
    getFileContentAtCommit: vi.fn(),
    fileExistsAtCommit: vi.fn(),
  };
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("reviewStage", () => {
  let tempDir: string;
  let originalCwd: string;
  let mockGetHeadCommit: ReturnType<typeof vi.fn>;
  let mockIsWorkingTreeDirty: ReturnType<typeof vi.fn>;
  let mockGetFileContentAtCommit: ReturnType<typeof vi.fn>;
  let mockFileExistsAtCommit: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "change-assurance-stage-test-"));
    process.chdir(tempDir);

    mockGetHeadCommit = vi.mocked(core.getHeadCommit);
    mockIsWorkingTreeDirty = vi.mocked(core.isWorkingTreeDirty);
    mockGetFileContentAtCommit = vi.mocked(core.getFileContentAtCommit);
    mockFileExistsAtCommit = vi.mocked(core.fileExistsAtCommit);
    mockGetHeadCommit.mockReset();
    mockIsWorkingTreeDirty.mockReset();
    mockGetFileContentAtCommit.mockReset();
    mockFileExistsAtCommit.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createRunFixture() {
    const runId = "test-run";
    const policy = { version: 1 };
    const changedFiles = [
      { path: "src/index.ts", status: "modified", additions: 10, deletions: 5 },
    ];
    const gitState = {
      baseRef: "main",
      headRef: "HEAD",
      baseCommit: "base123",
      headCommit: "abc123",
      branch: "main",
      isDirty: false,
      timestamp: "2024-01-01T00:00:00.000Z",
    };

    const policySnapshot = stringify(policy);
    const changedFilesJson = JSON.stringify(changedFiles, null, 2);
    const gitStateJson = JSON.stringify(gitState, null, 2);

    const manifest = {
      runId,
      baseRef: "main",
      headRef: "HEAD",
      createdAt: "2024-01-01T00:00:00.000Z",
      policySnapshotHash: sha256(policySnapshot),
      diffHash: sha256("diff content"),
      changedFilesHash: sha256(changedFilesJson),
      gitStateHash: sha256(gitStateJson),
    };

    const inputDir = join(tempDir, ".change-assurance", "runs", runId, "input");
    mkdirSync(inputDir, { recursive: true });

    writeFileSync(join(inputDir, "input-manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(inputDir, "diff.patch"), "diff content");
    writeFileSync(join(inputDir, "changed-files.json"), changedFilesJson);
    writeFileSync(join(inputDir, "git-state.json"), gitStateJson);
    writeFileSync(join(inputDir, "policy.snapshot.yaml"), policySnapshot);

    mockGetHeadCommit.mockReturnValue("abc123");
    mockIsWorkingTreeDirty.mockReturnValue(false);

    const inputManifestHash = sha256(JSON.stringify(manifest, null, 2));

    return { runId, inputManifestHash };
  }

  function createFakeAdapter(output: any) {
    return {
      detectCapabilities: () => ({
        available: true,
        version: "2.1.153",
        supportsJsonOutput: true,
        supportsJsonSchema: true,
      }),
      runStage: vi.fn().mockResolvedValue({ rawOutput: output, structuredOutput: output }),
    };
  }

  it("should throw StageError when run not found", async () => {
    const adapter = createFakeAdapter({});
    await expect(
      reviewStage({ runId: "nonexistent", stage: "change-map", adapter }),
    ).rejects.toThrow(StageError);
  });

  it("should throw StageError when input hash mismatch", async () => {
    const runId = "test-run-hash";
    const inputDir = join(tempDir, ".change-assurance", "runs", runId, "input");
    mkdirSync(inputDir, { recursive: true });

    writeFileSync(
      join(inputDir, "input-manifest.json"),
      JSON.stringify({
        runId,
        baseRef: "main",
        headRef: "HEAD",
        createdAt: "2024-01-01T00:00:00.000Z",
        policySnapshotHash: "wrong-hash",
        diffHash: sha256("diff"),
        changedFilesHash: sha256("[]"),
        gitStateHash: sha256("{}"),
      }),
    );
    writeFileSync(join(inputDir, "diff.patch"), "diff");
    writeFileSync(join(inputDir, "changed-files.json"), "[]");
    writeFileSync(join(inputDir, "git-state.json"), "{}");
    writeFileSync(join(inputDir, "policy.snapshot.yaml"), "version: 1");

    mockGetHeadCommit.mockReturnValue("abc123");
    mockIsWorkingTreeDirty.mockReturnValue(false);

    const adapter = createFakeAdapter({});
    await expect(reviewStage({ runId, stage: "change-map", adapter })).rejects.toThrow(StageError);
  });

  it("should generate change-map.json with valid adapter output", async () => {
    const { runId, inputManifestHash } = createRunFixture();
    const adapterOutput = {
      changedModules: [{ path: "src/index.ts", role: "entry", changeSummary: "modified" }],
      behaviorChanges: [],
      riskAreas: [],
      reviewPriorities: [],
      uncoveredContext: [],
      assumptions: ["Minimal change, no behavior impact"],
      sourceArtifacts: { inputManifestHash, policySnapshotHash: sha256(stringify({ version: 1 })) },
    };

    const adapter = createFakeAdapter(adapterOutput);
    const result = await reviewStage({ runId, stage: "change-map", adapter });

    expect(result.stageArtifactPath).toContain("change-map.json");

    const content = JSON.parse(readFileSync(result.stageArtifactPath, "utf-8"));
    expect(content.runId).toBe(runId);
    expect(content.stage).toBe("change-map");
    expect(content.changedModules).toHaveLength(1);
  });

  it("should reject output with blocker field", async () => {
    const { runId } = createRunFixture();
    const adapterOutput = {
      changedModules: [],
      behaviorChanges: [],
      riskAreas: [],
      reviewPriorities: [],
      uncoveredContext: [],
      assumptions: [],
      blocker: "some blocker",
    };

    const adapter = createFakeAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "change-map", adapter })).rejects.toThrow(StageError);
  });

  it("should reject output with invalid evidenceRefs", async () => {
    const { runId } = createRunFixture();
    const adapterOutput = {
      changedModules: [],
      behaviorChanges: [{ summary: "test", evidenceRefs: ["nonexistent-artifact"] }],
      riskAreas: [],
      reviewPriorities: [],
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createFakeAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "change-map", adapter })).rejects.toThrow(StageError);
  });

  it("should save raw output on adapter failure", async () => {
    const { runId } = createRunFixture();
    const adapter = {
      detectCapabilities: () => ({
        available: true,
        version: "2.1.153",
        supportsJsonOutput: true,
        supportsJsonSchema: true,
      }),
      runStage: vi.fn().mockRejectedValue(new Error("Claude CLI failed")),
    };

    await expect(reviewStage({ runId, stage: "change-map", adapter })).rejects.toThrow();

    const rawPath = join(
      tempDir,
      ".change-assurance",
      "runs",
      runId,
      "stages",
      "change-map.raw.json",
    );
    expect(readFileSync(rawPath, "utf-8")).toContain("error");
  });

  // Adequacy gate tests

  it("should reject empty changedModules when diff has changes", async () => {
    const { runId } = createRunFixture();
    const adapterOutput = {
      changedModules: [],
      behaviorChanges: [],
      riskAreas: [],
      reviewPriorities: [],
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createFakeAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "change-map", adapter })).rejects.toThrow(StageError);
  });

  it("should reject changedModules referencing unchaged files", async () => {
    const { runId } = createRunFixture();
    const adapterOutput = {
      changedModules: [{ path: "src/other.ts", role: "module", changeSummary: "changed" }],
      behaviorChanges: [],
      riskAreas: [],
      reviewPriorities: [],
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createFakeAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "change-map", adapter })).rejects.toThrow(StageError);
  });

  it("should reject empty analysis arrays without explanation", async () => {
    const { runId } = createRunFixture();
    const adapterOutput = {
      changedModules: [{ path: "src/index.ts", role: "entry", changeSummary: "modified" }],
      behaviorChanges: [],
      riskAreas: [],
      reviewPriorities: [],
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createFakeAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "change-map", adapter })).rejects.toThrow(StageError);
  });

  it("should accept empty analysis arrays with explanation in assumptions", async () => {
    const { runId, inputManifestHash } = createRunFixture();
    const adapterOutput = {
      changedModules: [{ path: "src/index.ts", role: "entry", changeSummary: "modified" }],
      behaviorChanges: [],
      riskAreas: [],
      reviewPriorities: [],
      uncoveredContext: [],
      assumptions: ["No behavior changes identified due to limited diff context"],
      sourceArtifacts: { inputManifestHash, policySnapshotHash: sha256(stringify({ version: 1 })) },
    };

    const adapter = createFakeAdapter(adapterOutput);
    const result = await reviewStage({ runId, stage: "change-map", adapter });
    expect(result.stageArtifactPath).toContain("change-map.json");
  });

  it("should compute sourceArtifacts correctly in artifact output", async () => {
    const { runId, inputManifestHash } = createRunFixture();
    const policySnapshotHash = sha256(stringify({ version: 1 }));
    const adapterOutput = {
      changedModules: [{ path: "src/index.ts", role: "entry", changeSummary: "modified" }],
      behaviorChanges: [],
      riskAreas: [],
      reviewPriorities: [],
      uncoveredContext: [],
      assumptions: ["test"],
      // LLM omits sourceArtifacts — harness computes it
    };

    const adapter = createFakeAdapter(adapterOutput);
    const result = await reviewStage({ runId, stage: "change-map", adapter });

    const content = JSON.parse(readFileSync(result.stageArtifactPath, "utf-8"));
    expect(content.sourceArtifacts.inputManifestHash).toBe(inputManifestHash);
    expect(content.sourceArtifacts.policySnapshotHash).toBe(policySnapshotHash);
  });

  it("should reject changedModules with empty role or changeSummary", async () => {
    const { runId } = createRunFixture();
    const adapterOutput = {
      changedModules: [{ path: "src/index.ts", role: "", changeSummary: "" }],
      behaviorChanges: [],
      riskAreas: [],
      reviewPriorities: [],
      uncoveredContext: [],
      assumptions: ["test"],
    };

    const adapter = createFakeAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "change-map", adapter })).rejects.toThrow(StageError);
  });
});

describe("behavior-review stage", () => {
  let tempDir: string;
  let originalCwd: string;
  let mockGetHeadCommit: ReturnType<typeof vi.fn>;
  let mockIsWorkingTreeDirty: ReturnType<typeof vi.fn>;
  let mockGetFileContentAtCommit: ReturnType<typeof vi.fn>;
  let mockFileExistsAtCommit: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "change-assurance-behavior-review-test-"));
    process.chdir(tempDir);

    mockGetHeadCommit = vi.mocked(core.getHeadCommit);
    mockIsWorkingTreeDirty = vi.mocked(core.isWorkingTreeDirty);
    mockGetFileContentAtCommit = vi.mocked(core.getFileContentAtCommit);
    mockFileExistsAtCommit = vi.mocked(core.fileExistsAtCommit);
    mockGetHeadCommit.mockReset();
    mockIsWorkingTreeDirty.mockReset();
    mockGetFileContentAtCommit.mockReset();
    mockFileExistsAtCommit.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createBehaviorReviewFixture(changeMapOutput?: any) {
    const runId = "test-behavior-review";
    const headCommit = "abc123def456";
    const policy = { version: 1 };
    const changedFiles = [
      { path: "src/index.ts", status: "modified", additions: 10, deletions: 5 },
    ];
    const gitState = {
      baseRef: "main",
      headRef: "HEAD",
      baseCommit: "base123",
      headCommit,
      branch: "main",
      isDirty: false,
      timestamp: "2024-01-01T00:00:00.000Z",
    };

    const policySnapshot = stringify(policy);
    const changedFilesJson = JSON.stringify(changedFiles, null, 2);
    const gitStateJson = JSON.stringify(gitState, null, 2);

    const manifest = {
      runId,
      baseRef: "main",
      headRef: "HEAD",
      createdAt: "2024-01-01T00:00:00.000Z",
      policySnapshotHash: sha256(policySnapshot),
      diffHash: sha256("diff content"),
      changedFilesHash: sha256(changedFilesJson),
      gitStateHash: sha256(gitStateJson),
    };

    const inputDir = join(tempDir, ".change-assurance", "runs", runId, "input");
    const stagesDir = join(tempDir, ".change-assurance", "runs", runId, "stages");
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(stagesDir, { recursive: true });

    writeFileSync(join(inputDir, "input-manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(inputDir, "diff.patch"), "diff content");
    writeFileSync(join(inputDir, "changed-files.json"), changedFilesJson);
    writeFileSync(join(inputDir, "git-state.json"), gitStateJson);
    writeFileSync(join(inputDir, "policy.snapshot.yaml"), policySnapshot);

    // Write change-map.json (required prerequisite)
    const changeMap = changeMapOutput ?? {
      runId,
      stage: "change-map",
      createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: {
        inputManifestHash: sha256(policySnapshot),
        policySnapshotHash: sha256(policySnapshot),
      },
      changedModules: [{ path: "src/index.ts", role: "entry", changeSummary: "modified" }],
      behaviorChanges: [],
      riskAreas: [],
      reviewPriorities: [],
      uncoveredContext: [],
      assumptions: ["test"],
    };
    writeFileSync(join(stagesDir, "change-map.json"), JSON.stringify(changeMap, null, 2));

    mockGetHeadCommit.mockReturnValue(headCommit);
    mockIsWorkingTreeDirty.mockReturnValue(false);
    mockFileExistsAtCommit.mockReturnValue(true);
    mockGetFileContentAtCommit.mockReturnValue(
      Array(20).fill("function foo() { return 1; }").join("\n"),
    );

    return { runId, headCommit };
  }

  function createBehaviorReviewAdapter(output: any) {
    return {
      detectCapabilities: () => ({
        available: true,
        version: "2.1.153",
        supportsJsonOutput: true,
        supportsJsonSchema: true,
      }),
      runStage: vi.fn().mockResolvedValue({ rawOutput: output, structuredOutput: output }),
    };
  }

  it("should generate behavior-review.json with valid finding and valid frozen source refs", async () => {
    const { runId, headCommit } = createBehaviorReviewFixture();
    const ref = `git:${headCommit}:src/index.ts#L1-L10`;

    const adapterOutput = {
      reviewedAreas: [
        { area: "entry", paths: ["src/index.ts"], focus: "core logic", evidenceRefs: [ref] },
      ],
      findings: [
        {
          id: "F001",
          title: "Missing error handling",
          type: "failure_path",
          candidateImpact: "material",
          trigger: "invalid input",
          observedBehavior: "throws uncaught",
          impact: "unhandled exception",
          recommendation: "add try-catch",
          evidenceRefs: [ref],
          confidence: "high",
        },
      ],
      uncoveredContext: [],
      assumptions: ["test"],
    };

    const adapter = createBehaviorReviewAdapter(adapterOutput);
    const result = await reviewStage({ runId, stage: "behavior-review", adapter });

    expect(result.stageArtifactPath).toContain("behavior-review.json");
    const content = JSON.parse(readFileSync(result.stageArtifactPath, "utf-8"));
    expect(content.stage).toBe("behavior-review");
    expect(content.findings).toHaveLength(1);
    expect(content.findings[0].id).toBe("F001");
  });

  it("should reject evidenceRef pointing to wrong commit", async () => {
    const { runId } = createBehaviorReviewFixture();
    const wrongRef = "git:wrongcommit123:src/index.ts#L1-L10";
    mockFileExistsAtCommit.mockImplementation((commit: string) => commit === "abc123def456");

    const adapterOutput = {
      reviewedAreas: [
        { area: "entry", paths: ["src/index.ts"], focus: "core logic", evidenceRefs: [wrongRef] },
      ],
      findings: [
        {
          id: "F001",
          title: "test",
          type: "failure_path",
          candidateImpact: "material",
          trigger: "x",
          observedBehavior: "y",
          impact: "z",
          recommendation: "w",
          evidenceRefs: [wrongRef],
          confidence: "high",
        },
      ],
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createBehaviorReviewAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "behavior-review", adapter })).rejects.toThrow(
      StageError,
    );
  });

  it("should reject evidenceRef with non-existent path or out-of-bounds line", async () => {
    const { runId, headCommit } = createBehaviorReviewFixture();
    const ref = `git:${headCommit}:src/nonexistent.ts#L1-L10`;
    mockFileExistsAtCommit.mockImplementation(
      (_commit: string, path: string) => path === "src/index.ts",
    );

    const adapterOutput = {
      reviewedAreas: [
        { area: "entry", paths: ["src/index.ts"], focus: "core logic", evidenceRefs: [ref] },
      ],
      findings: [
        {
          id: "F001",
          title: "test",
          type: "failure_path",
          candidateImpact: "material",
          trigger: "x",
          observedBehavior: "y",
          impact: "z",
          recommendation: "w",
          evidenceRefs: [ref],
          confidence: "high",
        },
      ],
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createBehaviorReviewAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "behavior-review", adapter })).rejects.toThrow(
      StageError,
    );
  });

  it("should reject finding missing trigger / impact / recommendation", async () => {
    const { runId, headCommit } = createBehaviorReviewFixture();
    const ref = `git:${headCommit}:src/index.ts#L1-L10`;

    const adapterOutput = {
      reviewedAreas: [
        { area: "entry", paths: ["src/index.ts"], focus: "core logic", evidenceRefs: [ref] },
      ],
      findings: [
        {
          id: "F001",
          title: "test",
          type: "failure_path",
          candidateImpact: "material",
          trigger: "",
          observedBehavior: "y",
          impact: "",
          recommendation: "",
          evidenceRefs: [ref],
          confidence: "high",
        },
      ],
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createBehaviorReviewAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "behavior-review", adapter })).rejects.toThrow(
      StageError,
    );
  });

  it("should reject output with merge recommendation or blocker field", async () => {
    const { runId, headCommit } = createBehaviorReviewFixture();
    const ref = `git:${headCommit}:src/index.ts#L1-L10`;

    const adapterOutput = {
      reviewedAreas: [
        { area: "entry", paths: ["src/index.ts"], focus: "core logic", evidenceRefs: [ref] },
      ],
      findings: [
        {
          id: "F001",
          title: "test",
          type: "failure_path",
          candidateImpact: "material",
          trigger: "x",
          observedBehavior: "y",
          impact: "z",
          recommendation: "w",
          evidenceRefs: [ref],
          confidence: "high",
        },
      ],
      uncoveredContext: [],
      assumptions: [],
      mergeRecommendation: "approve",
    };

    const adapter = createBehaviorReviewAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "behavior-review", adapter })).rejects.toThrow(
      StageError,
    );
  });

  it("should not call adapter when change-map is missing", async () => {
    const runId = "test-no-changemap";
    const inputDir = join(tempDir, ".change-assurance", "runs", runId, "input");
    mkdirSync(inputDir, { recursive: true });

    const policy = { version: 1 };
    const changedFiles = [
      { path: "src/index.ts", status: "modified", additions: 10, deletions: 5 },
    ];
    const gitState = {
      baseRef: "main",
      headRef: "HEAD",
      baseCommit: "base123",
      headCommit: "abc123",
      branch: "main",
      isDirty: false,
      timestamp: "2024-01-01T00:00:00.000Z",
    };

    const policySnapshot = stringify(policy);
    const changedFilesJson = JSON.stringify(changedFiles, null, 2);
    const gitStateJson = JSON.stringify(gitState, null, 2);

    const manifest = {
      runId,
      baseRef: "main",
      headRef: "HEAD",
      createdAt: "2024-01-01T00:00:00.000Z",
      policySnapshotHash: sha256(policySnapshot),
      diffHash: sha256("diff"),
      changedFilesHash: sha256(changedFilesJson),
      gitStateHash: sha256(gitStateJson),
    };

    writeFileSync(join(inputDir, "input-manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(inputDir, "diff.patch"), "diff");
    writeFileSync(join(inputDir, "changed-files.json"), changedFilesJson);
    writeFileSync(join(inputDir, "git-state.json"), gitStateJson);
    writeFileSync(join(inputDir, "policy.snapshot.yaml"), policySnapshot);

    // No stages/ directory → change-map.json missing

    mockGetHeadCommit.mockReturnValue("abc123");
    mockIsWorkingTreeDirty.mockReturnValue(false);

    const adapter = createBehaviorReviewAdapter({});
    await expect(reviewStage({ runId, stage: "behavior-review", adapter })).rejects.toThrow(
      StageError,
    );
    expect(adapter.runStage).not.toHaveBeenCalled();
  });

  it("should reject empty findings without reviewedAreas or uncoveredContext", async () => {
    const { runId } = createBehaviorReviewFixture();
    mockGetFileContentAtCommit.mockReturnValue("function foo() {}");

    const adapterOutput = {
      reviewedAreas: [],
      findings: [],
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createBehaviorReviewAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "behavior-review", adapter })).rejects.toThrow(
      StageError,
    );
  });

  it("should not be affected by working tree changes since evidence reads from frozen commit", async () => {
    const { runId, headCommit } = createBehaviorReviewFixture();
    const ref = `git:${headCommit}:src/index.ts#L1-L1`;

    // Simulate working tree having different content
    mockGetFileContentAtCommit.mockReturnValue("function originalCode() {}");

    const adapterOutput = {
      reviewedAreas: [
        { area: "entry", paths: ["src/index.ts"], focus: "core logic", evidenceRefs: [ref] },
      ],
      findings: [
        {
          id: "F001",
          title: "test",
          type: "regression_risk",
          candidateImpact: "advisory",
          trigger: "x",
          observedBehavior: "y",
          impact: "z",
          recommendation: "w",
          evidenceRefs: [ref],
          confidence: "medium",
        },
      ],
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createBehaviorReviewAdapter(adapterOutput);
    const result = await reviewStage({ runId, stage: "behavior-review", adapter });

    const content = JSON.parse(readFileSync(result.stageArtifactPath, "utf-8"));
    expect(content.findings[0].evidenceRefs[0]).toContain(headCommit);
  });
});

describe("test-review stage", () => {
  let tempDir: string;
  let originalCwd: string;
  let mockGetHeadCommit: ReturnType<typeof vi.fn>;
  let mockIsWorkingTreeDirty: ReturnType<typeof vi.fn>;
  let mockGetFileContentAtCommit: ReturnType<typeof vi.fn>;
  let mockFileExistsAtCommit: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "change-assurance-test-review-test-"));
    process.chdir(tempDir);

    mockGetHeadCommit = vi.mocked(core.getHeadCommit);
    mockIsWorkingTreeDirty = vi.mocked(core.isWorkingTreeDirty);
    mockGetFileContentAtCommit = vi.mocked(core.getFileContentAtCommit);
    mockFileExistsAtCommit = vi.mocked(core.fileExistsAtCommit);
    mockGetHeadCommit.mockReset();
    mockIsWorkingTreeDirty.mockReset();
    mockGetFileContentAtCommit.mockReset();
    mockFileExistsAtCommit.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createTestReviewFixture(opts?: {
    verificationLedger?: any;
    behaviorReviewOutput?: any;
  }) {
    const runId = "test-test-review";
    const headCommit = "abc123def456";
    const policy = { version: 1 };
    const changedFiles = [
      { path: "src/index.ts", status: "modified", additions: 10, deletions: 5 },
    ];
    const gitState = {
      baseRef: "main",
      headRef: "HEAD",
      baseCommit: "base123",
      headCommit,
      branch: "main",
      isDirty: false,
      timestamp: "2024-01-01T00:00:00.000Z",
    };

    const policySnapshot = stringify(policy);
    const changedFilesJson = JSON.stringify(changedFiles, null, 2);
    const gitStateJson = JSON.stringify(gitState, null, 2);

    const manifest = {
      runId,
      baseRef: "main",
      headRef: "HEAD",
      createdAt: "2024-01-01T00:00:00.000Z",
      policySnapshotHash: sha256(policySnapshot),
      diffHash: sha256("diff content"),
      changedFilesHash: sha256(changedFilesJson),
      gitStateHash: sha256(gitStateJson),
    };

    const inputDir = join(tempDir, ".change-assurance", "runs", runId, "input");
    const stagesDir = join(tempDir, ".change-assurance", "runs", runId, "stages");
    const verificationDir = join(tempDir, ".change-assurance", "runs", runId, "verification");
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(stagesDir, { recursive: true });

    writeFileSync(join(inputDir, "input-manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(inputDir, "diff.patch"), "diff content");
    writeFileSync(join(inputDir, "changed-files.json"), changedFilesJson);
    writeFileSync(join(inputDir, "git-state.json"), gitStateJson);
    writeFileSync(join(inputDir, "policy.snapshot.yaml"), policySnapshot);

    // Write change-map.json
    const changeMap = {
      runId,
      stage: "change-map",
      createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: {
        inputManifestHash: sha256(policySnapshot),
        policySnapshotHash: sha256(policySnapshot),
      },
      changedModules: [{ path: "src/index.ts", role: "entry", changeSummary: "modified" }],
      behaviorChanges: [{ summary: "added error handling", evidenceRefs: ["input/diff.patch"] }],
      riskAreas: [],
      reviewPriorities: [],
      uncoveredContext: [],
      assumptions: [],
    };
    writeFileSync(join(stagesDir, "change-map.json"), JSON.stringify(changeMap, null, 2));

    // Write behavior-review.json
    const behaviorReview = opts?.behaviorReviewOutput ?? {
      runId,
      stage: "behavior-review",
      createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: {
        inputManifestHash: sha256(policySnapshot),
        changeMapHash: sha256(JSON.stringify(changeMap)),
      },
      reviewedAreas: [
        {
          area: "entry",
          paths: ["src/index.ts"],
          focus: "error handling",
          evidenceRefs: [`git:${headCommit}:src/index.ts#L1-L5`],
        },
      ],
      findings: [
        {
          id: "B001",
          title: "Missing null check",
          type: "failure_path",
          candidateImpact: "material",
          trigger: "null input",
          observedBehavior: "throws",
          impact: "crash",
          recommendation: "add check",
          evidenceRefs: [`git:${headCommit}:src/index.ts#L3-L5`],
          confidence: "high",
        },
      ],
      uncoveredContext: [],
      assumptions: [],
    };
    writeFileSync(join(stagesDir, "behavior-review.json"), JSON.stringify(behaviorReview, null, 2));

    // Optionally write verification-ledger.json
    if (opts?.verificationLedger) {
      mkdirSync(verificationDir, { recursive: true });
      writeFileSync(
        join(verificationDir, "verification-ledger.json"),
        JSON.stringify(opts.verificationLedger, null, 2),
      );
    }

    mockGetHeadCommit.mockReturnValue(headCommit);
    mockIsWorkingTreeDirty.mockReturnValue(false);
    mockFileExistsAtCommit.mockReturnValue(true);
    mockGetFileContentAtCommit.mockReturnValue(
      Array(20).fill("function foo() { return 1; }").join("\n"),
    );

    return { runId, headCommit };
  }

  function createTestReviewAdapter(output: any) {
    return {
      detectCapabilities: () => ({
        available: true,
        version: "2.1.153",
        supportsJsonOutput: true,
        supportsJsonSchema: true,
      }),
      runStage: vi.fn().mockResolvedValue({ rawOutput: output, structuredOutput: output }),
    };
  }

  it("should generate test-review.json with valid behavior-to-test mapping", async () => {
    const { runId, headCommit } = createTestReviewFixture();
    const implRef = `git:${headCommit}:src/index.ts#L3-L5`;
    const testRef = `git:${headCommit}:src/__tests__/index.test.ts#L10-L15`;

    const adapterOutput = {
      reviewedBehaviors: [
        {
          behavior: "null input handling",
          implementationEvidenceRefs: [implRef],
          testEvidenceRefs: [testRef],
          assessment: "adequately_covered",
          rationale: "test covers null case",
        },
      ],
      findings: [],
      verificationAssessment: { testCommandStatus: "passed", note: "all tests pass" },
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createTestReviewAdapter(adapterOutput);
    const result = await reviewStage({ runId, stage: "test-review", adapter });

    expect(result.stageArtifactPath).toContain("test-review.json");
    const content = JSON.parse(readFileSync(result.stageArtifactPath, "utf-8"));
    expect(content.stage).toBe("test-review");
    expect(content.reviewedBehaviors).toHaveLength(1);
    expect(content.reviewedBehaviors[0].assessment).toBe("adequately_covered");
    // No verification ledger → harness forces to unavailable
    expect(content.verificationAssessment.testCommandStatus).toBe("unavailable");
  });

  it("should reject adequately_covered without testEvidenceRefs", async () => {
    const { runId, headCommit } = createTestReviewFixture();
    const implRef = `git:${headCommit}:src/index.ts#L3-L5`;

    const adapterOutput = {
      reviewedBehaviors: [
        {
          behavior: "null input handling",
          implementationEvidenceRefs: [implRef],
          testEvidenceRefs: [],
          assessment: "adequately_covered",
          rationale: "trust me",
        },
      ],
      findings: [],
      verificationAssessment: { testCommandStatus: "passed", note: "ok" },
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createTestReviewAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "test-review", adapter })).rejects.toThrow(StageError);
  });

  it("should reject missing_test finding without specific behavior", async () => {
    const { runId, headCommit } = createTestReviewFixture();
    const implRef = `git:${headCommit}:src/index.ts#L3-L5`;

    const adapterOutput = {
      reviewedBehaviors: [
        {
          behavior: "null input handling",
          implementationEvidenceRefs: [implRef],
          testEvidenceRefs: [],
          assessment: "not_covered",
          rationale: "no test found",
        },
      ],
      findings: [
        {
          id: "T001",
          title: "test gap",
          type: "missing_test",
          candidateImpact: "material",
          behavior: "",
          observedTestCoverage: "none",
          impact: "untested",
          recommendation: "add test",
          evidenceRefs: [implRef],
          confidence: "high",
        },
      ],
      verificationAssessment: { testCommandStatus: "passed", note: "ok" },
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createTestReviewAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "test-review", adapter })).rejects.toThrow(StageError);
  });

  it("should reject evidenceRef pointing to wrong commit", async () => {
    const { runId } = createTestReviewFixture();
    const wrongRef = "git:wrongcommit:src/index.ts#L1-L5";
    mockFileExistsAtCommit.mockImplementation((commit: string) => commit === "abc123def456");

    const adapterOutput = {
      reviewedBehaviors: [
        {
          behavior: "test",
          implementationEvidenceRefs: [wrongRef],
          testEvidenceRefs: [],
          assessment: "not_covered",
          rationale: "no test",
        },
      ],
      findings: [
        {
          id: "T001",
          title: "gap",
          type: "missing_test",
          candidateImpact: "material",
          behavior: "test",
          observedTestCoverage: "none",
          impact: "untested",
          recommendation: "add test",
          evidenceRefs: [wrongRef],
          confidence: "high",
        },
      ],
      verificationAssessment: { testCommandStatus: "passed", note: "ok" },
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createTestReviewAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "test-review", adapter })).rejects.toThrow(StageError);
  });

  it("should reject when verification ledger shows failed but model says passed", async () => {
    const { runId, headCommit } = createTestReviewFixture({
      verificationLedger: {
        runId: "test-test-review",
        createdAt: "2024-01-01T00:00:00.000Z",
        runStatus: "completed",
        policySnapshotHash: "test",
        preconditionErrors: [],
        commands: [{ id: "test", argv: ["pnpm", "test"], required: true, status: "failed" }],
        summary: { passed: 0, failed: 1, skipped: 0, notRequired: 0 },
        workspaceChangedAfterVerify: false,
      },
    });
    const implRef = `git:${headCommit}:src/index.ts#L3-L5`;

    const adapterOutput = {
      reviewedBehaviors: [
        {
          behavior: "test",
          implementationEvidenceRefs: [implRef],
          testEvidenceRefs: [],
          assessment: "not_covered",
          rationale: "no test",
        },
      ],
      findings: [],
      verificationAssessment: { testCommandStatus: "passed", note: "all pass" },
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createTestReviewAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "test-review", adapter })).rejects.toThrow(StageError);
  });

  it("should set testCommandStatus to unavailable when no verification ledger", async () => {
    const { runId, headCommit } = createTestReviewFixture();
    const implRef = `git:${headCommit}:src/index.ts#L3-L5`;

    const adapterOutput = {
      reviewedBehaviors: [
        {
          behavior: "test",
          implementationEvidenceRefs: [implRef],
          testEvidenceRefs: [],
          assessment: "not_covered",
          rationale: "no test",
        },
      ],
      findings: [],
      verificationAssessment: { testCommandStatus: "passed", note: "ok" },
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createTestReviewAdapter(adapterOutput);
    const result = await reviewStage({ runId, stage: "test-review", adapter });

    const content = JSON.parse(readFileSync(result.stageArtifactPath, "utf-8"));
    expect(content.verificationAssessment.testCommandStatus).toBe("unavailable");
  });

  it("should reject output with blocker or merge recommendation field", async () => {
    const { runId, headCommit } = createTestReviewFixture();
    const implRef = `git:${headCommit}:src/index.ts#L3-L5`;

    const adapterOutput = {
      reviewedBehaviors: [
        {
          behavior: "test",
          implementationEvidenceRefs: [implRef],
          testEvidenceRefs: [],
          assessment: "not_covered",
          rationale: "no test",
        },
      ],
      findings: [],
      verificationAssessment: { testCommandStatus: "unavailable", note: "no ledger" },
      uncoveredContext: [],
      assumptions: [],
      mergeRecommendation: "approve",
    };

    const adapter = createTestReviewAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "test-review", adapter })).rejects.toThrow(StageError);
  });

  it("should not be affected by working tree changes since evidence reads from frozen commit", async () => {
    const { runId, headCommit } = createTestReviewFixture();
    const implRef = `git:${headCommit}:src/index.ts#L3-L5`;

    mockGetFileContentAtCommit.mockReturnValue(
      Array(20).fill("function originalCode() {}").join("\n"),
    );

    const adapterOutput = {
      reviewedBehaviors: [
        {
          behavior: "test",
          implementationEvidenceRefs: [implRef],
          testEvidenceRefs: [implRef],
          assessment: "adequately_covered",
          rationale: "covered",
        },
      ],
      findings: [],
      verificationAssessment: { testCommandStatus: "passed", note: "ok" },
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createTestReviewAdapter(adapterOutput);
    const result = await reviewStage({ runId, stage: "test-review", adapter });

    const content = JSON.parse(readFileSync(result.stageArtifactPath, "utf-8"));
    expect(content.reviewedBehaviors[0].testEvidenceRefs[0]).toContain(headCommit);
    expect(content.verificationAssessment.testCommandStatus).toBe("unavailable");
  });
});

describe("evidence-audit stage", () => {
  let tempDir: string;
  let originalCwd: string;
  let mockGetHeadCommit: ReturnType<typeof vi.fn>;
  let mockIsWorkingTreeDirty: ReturnType<typeof vi.fn>;
  let mockGetFileContentAtCommit: ReturnType<typeof vi.fn>;
  let mockFileExistsAtCommit: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "change-assurance-evidence-audit-test-"));
    process.chdir(tempDir);

    mockGetHeadCommit = vi.mocked(core.getHeadCommit);
    mockIsWorkingTreeDirty = vi.mocked(core.isWorkingTreeDirty);
    mockGetFileContentAtCommit = vi.mocked(core.getFileContentAtCommit);
    mockFileExistsAtCommit = vi.mocked(core.fileExistsAtCommit);
    mockGetHeadCommit.mockReset();
    mockIsWorkingTreeDirty.mockReset();
    mockGetFileContentAtCommit.mockReset();
    mockFileExistsAtCommit.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createEvidenceAuditFixture(opts?: {
    behaviorReviewFindings?: any[];
    testReviewFindings?: any[];
  }) {
    const runId = "test-evidence-audit";
    const headCommit = "abc123def456";
    const policy = { version: 1 };
    const changedFiles = [
      { path: "src/index.ts", status: "modified", additions: 10, deletions: 5 },
    ];
    const gitState = {
      baseRef: "main",
      headRef: "HEAD",
      baseCommit: "base123",
      headCommit,
      branch: "main",
      isDirty: false,
      timestamp: "2024-01-01T00:00:00.000Z",
    };

    const policySnapshot = stringify(policy);
    const changedFilesJson = JSON.stringify(changedFiles, null, 2);
    const gitStateJson = JSON.stringify(gitState, null, 2);

    const manifest = {
      runId,
      baseRef: "main",
      headRef: "HEAD",
      createdAt: "2024-01-01T00:00:00.000Z",
      policySnapshotHash: sha256(policySnapshot),
      diffHash: sha256("diff content"),
      changedFilesHash: sha256(changedFilesJson),
      gitStateHash: sha256(gitStateJson),
    };

    const inputDir = join(tempDir, ".change-assurance", "runs", runId, "input");
    const stagesDir = join(tempDir, ".change-assurance", "runs", runId, "stages");
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(stagesDir, { recursive: true });

    writeFileSync(join(inputDir, "input-manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(inputDir, "diff.patch"), "diff content");
    writeFileSync(join(inputDir, "changed-files.json"), changedFilesJson);
    writeFileSync(join(inputDir, "git-state.json"), gitStateJson);
    writeFileSync(join(inputDir, "policy.snapshot.yaml"), policySnapshot);

    const changeMap = {
      runId,
      stage: "change-map",
      createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: {
        inputManifestHash: sha256(policySnapshot),
        policySnapshotHash: sha256(policySnapshot),
      },
      changedModules: [{ path: "src/index.ts", role: "entry", changeSummary: "modified" }],
      behaviorChanges: [],
      riskAreas: [],
      reviewPriorities: [],
      uncoveredContext: [],
      assumptions: [],
    };
    writeFileSync(join(stagesDir, "change-map.json"), JSON.stringify(changeMap, null, 2));

    const brFindings = opts?.behaviorReviewFindings ?? [
      {
        id: "B001",
        title: "Missing null check",
        type: "failure_path",
        candidateImpact: "material",
        trigger: "null input",
        observedBehavior: "throws",
        impact: "crash",
        recommendation: "add check",
        evidenceRefs: [`git:${headCommit}:src/index.ts#L3-L5`],
        confidence: "high",
      },
    ];
    const behaviorReview = {
      runId,
      stage: "behavior-review",
      createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: {
        inputManifestHash: sha256(policySnapshot),
        changeMapHash: sha256(JSON.stringify(changeMap)),
      },
      reviewedAreas: [
        {
          area: "entry",
          paths: ["src/index.ts"],
          focus: "core",
          evidenceRefs: [`git:${headCommit}:src/index.ts#L1-L5`],
        },
      ],
      findings: brFindings,
      uncoveredContext: [],
      assumptions: [],
    };
    writeFileSync(join(stagesDir, "behavior-review.json"), JSON.stringify(behaviorReview, null, 2));

    const trFindings = opts?.testReviewFindings ?? [
      {
        id: "T001",
        title: "Missing test for null input",
        type: "missing_test",
        candidateImpact: "material",
        behavior: "null input handling",
        observedTestCoverage: "none",
        impact: "untested",
        recommendation: "add test",
        evidenceRefs: [`git:${headCommit}:src/index.ts#L3-L5`],
        confidence: "high",
      },
    ];
    const testReview = {
      runId,
      stage: "test-review",
      createdAt: "2024-01-01T00:00:00.000Z",
      sourceArtifacts: {
        inputManifestHash: sha256(policySnapshot),
        changeMapHash: sha256(JSON.stringify(changeMap)),
        behaviorReviewHash: sha256(JSON.stringify(behaviorReview)),
      },
      reviewedBehaviors: [
        {
          behavior: "null input handling",
          implementationEvidenceRefs: [`git:${headCommit}:src/index.ts#L3-L5`],
          testEvidenceRefs: [],
          assessment: "not_covered",
          rationale: "no test",
        },
      ],
      findings: trFindings,
      verificationAssessment: { testCommandStatus: "unavailable", note: "no ledger" },
      uncoveredContext: [],
      assumptions: [],
    };
    writeFileSync(join(stagesDir, "test-review.json"), JSON.stringify(testReview, null, 2));

    mockGetHeadCommit.mockReturnValue(headCommit);
    mockIsWorkingTreeDirty.mockReturnValue(false);
    mockFileExistsAtCommit.mockReturnValue(true);
    mockGetFileContentAtCommit.mockReturnValue(
      Array(20).fill("function foo() { return 1; }").join("\n"),
    );

    return { runId, headCommit };
  }

  function createEvidenceAuditAdapter(output: any) {
    return {
      detectCapabilities: () => ({
        available: true,
        version: "2.1.153",
        supportsJsonOutput: true,
        supportsJsonSchema: true,
      }),
      runStage: vi.fn().mockResolvedValue({ rawOutput: output, structuredOutput: output }),
    };
  }

  it("should accept observed finding with complete evidence", async () => {
    const { runId, headCommit } = createEvidenceAuditFixture();
    const ref = `git:${headCommit}:src/index.ts#L3-L5`;

    const adapterOutput = {
      auditedFindings: [
        {
          sourceFindingRef: "B001",
          sourceStage: "behavior-review",
          disposition: "accepted",
          evidenceClass: "observed",
          effectiveCandidateImpact: "material",
          rationale: "null check missing, verified in source",
          verifiedEvidenceRefs: [ref],
          missingEvidence: [],
          missingContext: [],
        },
      ],
      summary: { accepted: 1, downgraded: 0, needsContext: 0, rejected: 0 },
      assumptions: [],
    };

    const adapter = createEvidenceAuditAdapter(adapterOutput);
    const result = await reviewStage({ runId, stage: "evidence-audit", adapter });

    const content = JSON.parse(readFileSync(result.stageArtifactPath, "utf-8"));
    expect(content.stage).toBe("evidence-audit");
    expect(content.auditedFindings).toHaveLength(1);
    expect(content.auditedFindings[0].disposition).toBe("accepted");
  });

  it("should reject hypothesis finding marked as merge_blocking", async () => {
    const { runId, headCommit } = createEvidenceAuditFixture();
    const ref = `git:${headCommit}:src/index.ts#L3-L5`;

    const adapterOutput = {
      auditedFindings: [
        {
          sourceFindingRef: "B001",
          sourceStage: "behavior-review",
          disposition: "accepted",
          evidenceClass: "hypothesis",
          effectiveCandidateImpact: "merge_blocking",
          rationale: "might be a problem",
          verifiedEvidenceRefs: [ref],
          missingEvidence: [],
          missingContext: [],
        },
      ],
      summary: { accepted: 1, downgraded: 0, needsContext: 0, rejected: 0 },
      assumptions: [],
    };

    const adapter = createEvidenceAuditAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "evidence-audit", adapter })).rejects.toThrow(
      StageError,
    );
  });

  it("should reject audit that adds evidenceRef not in source finding", async () => {
    const { runId } = createEvidenceAuditFixture();

    const adapterOutput = {
      auditedFindings: [
        {
          sourceFindingRef: "B001",
          sourceStage: "behavior-review",
          disposition: "accepted",
          evidenceClass: "observed",
          effectiveCandidateImpact: "material",
          rationale: "verified",
          verifiedEvidenceRefs: ["git:abc123def456:src/nonexistent.ts#L1-L2"],
          missingEvidence: [],
          missingContext: [],
        },
      ],
      summary: { accepted: 1, downgraded: 0, needsContext: 0, rejected: 0 },
      assumptions: [],
    };

    const adapter = createEvidenceAuditAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "evidence-audit", adapter })).rejects.toThrow(
      StageError,
    );
  });

  it("should reject audit that upgrades material to merge_blocking", async () => {
    const { runId, headCommit } = createEvidenceAuditFixture();
    const ref = `git:${headCommit}:src/index.ts#L3-L5`;

    const adapterOutput = {
      auditedFindings: [
        {
          sourceFindingRef: "B001",
          sourceStage: "behavior-review",
          disposition: "accepted",
          evidenceClass: "observed",
          effectiveCandidateImpact: "merge_blocking",
          rationale: "critical",
          verifiedEvidenceRefs: [ref],
          missingEvidence: [],
          missingContext: [],
        },
      ],
      summary: { accepted: 1, downgraded: 0, needsContext: 0, rejected: 0 },
      assumptions: [],
    };

    const adapter = createEvidenceAuditAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "evidence-audit", adapter })).rejects.toThrow(
      StageError,
    );
  });

  it("should reject invalid sourceFindingRef", async () => {
    const { runId } = createEvidenceAuditFixture();

    const adapterOutput = {
      auditedFindings: [
        {
          sourceFindingRef: "NONEXISTENT",
          sourceStage: "behavior-review",
          disposition: "accepted",
          evidenceClass: "observed",
          effectiveCandidateImpact: "material",
          rationale: "verified",
          verifiedEvidenceRefs: [],
          missingEvidence: [],
          missingContext: [],
        },
      ],
      summary: { accepted: 1, downgraded: 0, needsContext: 0, rejected: 0 },
      assumptions: [],
    };

    const adapter = createEvidenceAuditAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "evidence-audit", adapter })).rejects.toThrow(
      StageError,
    );
  });

  it("should reject deduplicatedWith pointing to nonexistent finding", async () => {
    const { runId, headCommit } = createEvidenceAuditFixture();
    const ref = `git:${headCommit}:src/index.ts#L3-L5`;

    const adapterOutput = {
      auditedFindings: [
        {
          sourceFindingRef: "B001",
          sourceStage: "behavior-review",
          disposition: "accepted",
          evidenceClass: "observed",
          effectiveCandidateImpact: "material",
          rationale: "verified",
          verifiedEvidenceRefs: [ref],
          missingEvidence: [],
          missingContext: [],
          deduplicatedWith: "FAKE_ID",
        },
      ],
      summary: { accepted: 1, downgraded: 0, needsContext: 0, rejected: 0 },
      assumptions: [],
    };

    const adapter = createEvidenceAuditAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "evidence-audit", adapter })).rejects.toThrow(
      StageError,
    );
  });

  it("should reject rejected finding that still has impact", async () => {
    const { runId } = createEvidenceAuditFixture();

    const adapterOutput = {
      auditedFindings: [
        {
          sourceFindingRef: "B001",
          sourceStage: "behavior-review",
          disposition: "rejected",
          evidenceClass: "hypothesis",
          effectiveCandidateImpact: "material",
          rationale: "insufficient evidence",
          verifiedEvidenceRefs: [],
          missingEvidence: ["no proof"],
          missingContext: [],
        },
      ],
      summary: { accepted: 0, downgraded: 0, needsContext: 0, rejected: 1 },
      assumptions: [],
    };

    const adapter = createEvidenceAuditAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "evidence-audit", adapter })).rejects.toThrow(
      StageError,
    );
  });

  it("should reject summary count mismatch", async () => {
    const { runId, headCommit } = createEvidenceAuditFixture();
    const ref = `git:${headCommit}:src/index.ts#L3-L5`;

    const adapterOutput = {
      auditedFindings: [
        {
          sourceFindingRef: "B001",
          sourceStage: "behavior-review",
          disposition: "accepted",
          evidenceClass: "observed",
          effectiveCandidateImpact: "material",
          rationale: "verified",
          verifiedEvidenceRefs: [ref],
          missingEvidence: [],
          missingContext: [],
        },
      ],
      summary: { accepted: 2, downgraded: 0, needsContext: 0, rejected: 0 },
      assumptions: [],
    };

    const adapter = createEvidenceAuditAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "evidence-audit", adapter })).rejects.toThrow(
      StageError,
    );
  });

  it("should reject output with merge recommendation or blocker field", async () => {
    const { runId, headCommit } = createEvidenceAuditFixture();
    const ref = `git:${headCommit}:src/index.ts#L3-L5`;

    const adapterOutput = {
      auditedFindings: [
        {
          sourceFindingRef: "B001",
          sourceStage: "behavior-review",
          disposition: "accepted",
          evidenceClass: "observed",
          effectiveCandidateImpact: "material",
          rationale: "verified",
          verifiedEvidenceRefs: [ref],
          missingEvidence: [],
          missingContext: [],
        },
      ],
      summary: { accepted: 1, downgraded: 0, needsContext: 0, rejected: 0 },
      assumptions: [],
      mergeRecommendation: "approve",
    };

    const adapter = createEvidenceAuditAdapter(adapterOutput);
    await expect(reviewStage({ runId, stage: "evidence-audit", adapter })).rejects.toThrow(
      StageError,
    );
  });
});
