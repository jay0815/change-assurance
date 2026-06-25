import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reviewStage, StageError } from "../review-stage.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import * as core from "@change-assurance/core";

vi.mock("@change-assurance/core", async () => {
  const actual = await vi.importActual<typeof import("@change-assurance/core")>("@change-assurance/core");
  return {
    ...actual,
    getHeadCommit: vi.fn(),
    isWorkingTreeDirty: vi.fn(),
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

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "change-assurance-stage-test-"));
    process.chdir(tempDir);

    mockGetHeadCommit = vi.mocked(core.getHeadCommit);
    mockIsWorkingTreeDirty = vi.mocked(core.isWorkingTreeDirty);
    mockGetHeadCommit.mockReset();
    mockIsWorkingTreeDirty.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createRunFixture() {
    const runId = "test-run";
    const policy = { version: 1 };
    const changedFiles = [{ path: "src/index.ts", status: "modified", additions: 10, deletions: 5 }];
    const gitState = {
      baseRef: "main", headRef: "HEAD", baseCommit: "base123", headCommit: "abc123",
      branch: "main", isDirty: false, timestamp: "2024-01-01T00:00:00.000Z",
    };

    const policySnapshot = stringify(policy);
    const changedFilesJson = JSON.stringify(changedFiles, null, 2);
    const gitStateJson = JSON.stringify(gitState, null, 2);

    const manifest = {
      runId, baseRef: "main", headRef: "HEAD", createdAt: "2024-01-01T00:00:00.000Z",
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

    return runId;
  }

  function createFakeAdapter(output: any) {
    return {
      detectCapabilities: () => ({ available: true, version: "2.1.153", supportsJsonOutput: true, supportsJsonSchema: true }),
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

    writeFileSync(join(inputDir, "input-manifest.json"), JSON.stringify({
      runId, baseRef: "main", headRef: "HEAD", createdAt: "2024-01-01T00:00:00.000Z",
      policySnapshotHash: "wrong-hash",
      diffHash: sha256("diff"),
      changedFilesHash: sha256("[]"),
      gitStateHash: sha256("{}"),
    }));
    writeFileSync(join(inputDir, "diff.patch"), "diff");
    writeFileSync(join(inputDir, "changed-files.json"), "[]");
    writeFileSync(join(inputDir, "git-state.json"), "{}");
    writeFileSync(join(inputDir, "policy.snapshot.yaml"), "version: 1");

    mockGetHeadCommit.mockReturnValue("abc123");
    mockIsWorkingTreeDirty.mockReturnValue(false);

    const adapter = createFakeAdapter({});
    await expect(
      reviewStage({ runId, stage: "change-map", adapter }),
    ).rejects.toThrow(StageError);
  });

  it("should generate change-map.json with valid adapter output", async () => {
    const runId = createRunFixture();
    const adapterOutput = {
      changedModules: [{ path: "src/index.ts", role: "entry", changeSummary: "modified" }],
      behaviorChanges: [],
      riskAreas: [],
      reviewPriorities: [],
      uncoveredContext: [],
      assumptions: [],
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
    const runId = createRunFixture();
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
    await expect(
      reviewStage({ runId, stage: "change-map", adapter }),
    ).rejects.toThrow(StageError);
  });

  it("should reject output with invalid evidenceRefs", async () => {
    const runId = createRunFixture();
    const adapterOutput = {
      changedModules: [],
      behaviorChanges: [{ summary: "test", evidenceRefs: ["nonexistent-artifact"] }],
      riskAreas: [],
      reviewPriorities: [],
      uncoveredContext: [],
      assumptions: [],
    };

    const adapter = createFakeAdapter(adapterOutput);
    await expect(
      reviewStage({ runId, stage: "change-map", adapter }),
    ).rejects.toThrow(StageError);
  });

  it("should save raw output on adapter failure", async () => {
    const runId = createRunFixture();
    const adapter = {
      detectCapabilities: () => ({ available: true, version: "2.1.153", supportsJsonOutput: true, supportsJsonSchema: true }),
      runStage: vi.fn().mockRejectedValue(new Error("Claude CLI failed")),
    };

    await expect(
      reviewStage({ runId, stage: "change-map", adapter }),
    ).rejects.toThrow();

    const rawPath = join(tempDir, ".change-assurance", "runs", runId, "stages", "change-map.raw.json");
    expect(readFileSync(rawPath, "utf-8")).toContain("error");
  });
});
