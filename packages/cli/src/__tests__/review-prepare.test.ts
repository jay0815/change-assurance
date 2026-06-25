import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reviewPrepare, PrepareError } from "../review-prepare.js";
import { GitError } from "@change-assurance/core";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

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

vi.mock("../policy.js", () => ({
  loadPolicy: vi.fn().mockReturnValue({}),
}));

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("reviewPrepare", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "change-assurance-test-"));
    process.chdir(tempDir);

    const core = await import("@change-assurance/core");
    vi.mocked(core.isGitRepository).mockReset();
    vi.mocked(core.refExists).mockReset();
    vi.mocked(core.collectGitState).mockReset();
    vi.mocked(core.getDiff).mockReset();
    vi.mocked(core.getChangedFiles).mockReset();

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
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("happy path", () => {
    it("should create run with all artifacts", () => {
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

    it("should write correct content to artifact files", () => {
      const result = reviewPrepare({ base: "main", head: "HEAD" });
      const inputDir = result.inputDir;

      const diff = readFileSync(join(inputDir, "diff.patch"), "utf-8");
      expect(diff).toBe("diff content");

      const changedFiles = JSON.parse(readFileSync(join(inputDir, "changed-files.json"), "utf-8"));
      expect(changedFiles).toEqual([
        { path: "src/file.ts", status: "modified", additions: 10, deletions: 5 },
      ]);

      const gitState = JSON.parse(readFileSync(join(inputDir, "git-state.json"), "utf-8"));
      expect(gitState.baseCommit).toBe("base123");
      expect(gitState.headCommit).toBe("head456");
    });

    it("should generate valid input manifest with correct hashes", () => {
      const result = reviewPrepare({ base: "main", head: "HEAD" });

      const manifestPath = join(result.inputDir, "input-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

      expect(manifest.runId).toBe(result.runId);
      expect(manifest.baseRef).toBe("main");
      expect(manifest.headRef).toBe("HEAD");
      expect(manifest.createdAt).toBeDefined();

      expect(manifest.diffHash).toBe(sha256("diff content"));
      expect(manifest.changedFilesHash).toBe(
        sha256(JSON.stringify([{ path: "src/file.ts", status: "modified", additions: 10, deletions: 5 }])),
      );
      expect(manifest.policySnapshotHash).toBe(sha256(JSON.stringify({}, null, 2)));
      expect(manifest.gitStateHash).toBe(
        sha256(JSON.stringify({
          baseRef: "main",
          headRef: "HEAD",
          baseCommit: "base123",
          headCommit: "head456",
          branch: "main",
          isDirty: false,
          timestamp: "2024-01-01T00:00:00.000Z",
        })),
      );
    });
  });

  describe("error paths", () => {
    it("should throw PrepareError when not in git repository", async () => {
      const core = await import("@change-assurance/core");
      vi.mocked(core.isGitRepository).mockReturnValue(false);

      try {
        reviewPrepare({ base: "main", head: "HEAD" });
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(PrepareError);
        expect((error as Error).message).toBe("Not a git repository");
      }
    });

    it("should throw PrepareError when base ref does not exist", async () => {
      const core = await import("@change-assurance/core");
      vi.mocked(core.refExists).mockImplementation((ref) => ref !== "nonexistent");

      try {
        reviewPrepare({ base: "nonexistent", head: "HEAD" });
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(PrepareError);
        expect((error as Error).message).toBe("Base ref not found: nonexistent");
      }
    });

    it("should throw PrepareError when head ref does not exist", async () => {
      const core = await import("@change-assurance/core");
      vi.mocked(core.refExists).mockImplementation((ref) => ref !== "nonexistent");

      try {
        reviewPrepare({ base: "main", head: "nonexistent" });
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(PrepareError);
        expect((error as Error).message).toBe("Head ref not found: nonexistent");
      }
    });

    it("should propagate GitError when getDiff fails", async () => {
      const core = await import("@change-assurance/core");
      vi.mocked(core.getDiff).mockImplementation(() => {
        throw new GitError("git diff failed");
      });

      try {
        reviewPrepare({ base: "main", head: "HEAD" });
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitError);
        expect((error as Error).message).toBe("git diff failed");
      }
    });

    it("should propagate GitError when collectGitState fails", async () => {
      const core = await import("@change-assurance/core");
      vi.mocked(core.collectGitState).mockImplementation(() => {
        throw new GitError("git rev-parse failed");
      });

      try {
        reviewPrepare({ base: "main", head: "HEAD" });
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitError);
        expect((error as Error).message).toBe("git rev-parse failed");
      }
    });
  });
});
