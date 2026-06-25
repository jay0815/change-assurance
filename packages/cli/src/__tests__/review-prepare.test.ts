import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reviewPrepare, PrepareError } from "../review-prepare.js";
import { GitError } from "@change-assurance/core";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@change-assurance/core", async () => {
  const actual = await vi.importActual("@change-assurance/core");
  return {
    ...actual,
    isGitRepository: vi.fn(),
    refExists: vi.fn(),
    collectGitState: vi.fn(),
    getDiff: vi.fn(),
    getChangedFiles: vi.fn(),
  };
});

describe("reviewPrepare", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "change-assurance-test-"));
    process.chdir(tempDir);

    const core = await import("@change-assurance/core");
    vi.mocked(core.isGitRepository).mockReturnValue(true);
    vi.mocked(core.refExists).mockReturnValue(true);
    vi.mocked(core.collectGitState).mockReturnValue({
      baseRef: "main",
      headRef: "HEAD",
      baseCommit: "base123",
      headCommit: "head456",
      branch: "main",
      isDirty: false,
      timestamp: "2024-01-01T00:00:00.000Z",
    });
    vi.mocked(core.getDiff).mockReturnValue("diff content");
    vi.mocked(core.getChangedFiles).mockReturnValue([
      {
        path: "src/file.ts",
        status: "modified",
        additions: 10,
        deletions: 5,
      },
    ]);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("should create run with all artifacts", async () => {
    const result = reviewPrepare({ base: "main", head: "HEAD" });

    expect(result.runId).toBeDefined();
    expect(result.inputDir).toBeDefined();

    const inputDir = result.inputDir;
    expect(existsSync(join(inputDir, "input-manifest.json"))).toBe(true);
    expect(existsSync(join(inputDir, "diff.patch"))).toBe(true);
    expect(existsSync(join(inputDir, "changed-files.json"))).toBe(true);
    expect(existsSync(join(inputDir, "git-state.json"))).toBe(true);
    expect(existsSync(join(inputDir, "policy.snapshot.yaml"))).toBe(true);
  });

  it("should throw PrepareError when not in git repository", async () => {
    const core = await import("@change-assurance/core");
    vi.mocked(core.isGitRepository).mockReturnValue(false);

    expect(() => reviewPrepare({ base: "main", head: "HEAD" })).toThrow(
      PrepareError,
    );
    expect(() => reviewPrepare({ base: "main", head: "HEAD" })).toThrow(
      "Not a git repository",
    );
  });

  it("should throw PrepareError when base ref does not exist", async () => {
    const core = await import("@change-assurance/core");
    vi.mocked(core.refExists).mockImplementation((ref) => ref !== "nonexistent");

    expect(() =>
      reviewPrepare({ base: "nonexistent", head: "HEAD" }),
    ).toThrow(PrepareError);
    expect(() =>
      reviewPrepare({ base: "nonexistent", head: "HEAD" }),
    ).toThrow("Base ref not found: nonexistent");
  });

  it("should throw PrepareError when head ref does not exist", async () => {
    const core = await import("@change-assurance/core");
    vi.mocked(core.refExists).mockImplementation((ref) => ref !== "nonexistent");

    expect(() =>
      reviewPrepare({ base: "main", head: "nonexistent" }),
    ).toThrow(PrepareError);
    expect(() =>
      reviewPrepare({ base: "main", head: "nonexistent" }),
    ).toThrow("Head ref not found: nonexistent");
  });

  it("should generate valid input manifest", async () => {
    const result = reviewPrepare({ base: "main", head: "HEAD" });

    const manifestPath = join(result.inputDir, "input-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

    expect(manifest.runId).toBe(result.runId);
    expect(manifest.baseRef).toBe("main");
    expect(manifest.headRef).toBe("HEAD");
    expect(manifest.createdAt).toBeDefined();
    expect(manifest.policySnapshotHash).toBeDefined();
    expect(manifest.diffHash).toBeDefined();
    expect(manifest.changedFilesHash).toBeDefined();
    expect(manifest.gitStateHash).toBeDefined();
  });
});
