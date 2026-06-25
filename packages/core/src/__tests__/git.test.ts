import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isGitRepository,
  refExists,
  getHeadCommit,
  getCurrentBranch,
  isWorkingTreeDirty,
  getDiff,
  getChangedFiles,
  getBaseCommit,
  collectGitState,
  GitError,
} from "../git.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

describe("git", () => {
  let mockExecSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const { execFileSync } = await import("node:child_process");
    mockExecSync = vi.mocked(execFileSync);
    mockExecSync.mockReset();
  });

  describe("isGitRepository", () => {
    it("should return true when in a git repository", () => {
      mockExecSync.mockReturnValue("true");
      expect(isGitRepository()).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith("git", ["rev-parse", "--is-inside-work-tree"], expect.any(Object));
    });

    it("should return false when not in a git repository", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not a git repo");
      });
      expect(isGitRepository()).toBe(false);
    });
  });

  describe("refExists", () => {
    it("should return true when ref exists", () => {
      mockExecSync.mockReturnValue("abc123");
      expect(refExists("main")).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith("git", ["rev-parse", "--verify", "main"], expect.any(Object));
    });

    it("should return false when ref does not exist", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("unknown ref");
      });
      expect(refExists("nonexistent")).toBe(false);
    });
  });

  describe("getHeadCommit", () => {
    it("should return HEAD commit hash", () => {
      mockExecSync.mockReturnValue("abc123def456");
      expect(getHeadCommit()).toBe("abc123def456");
    });
  });

  describe("getCurrentBranch", () => {
    it("should return current branch name", () => {
      mockExecSync.mockReturnValue("main");
      expect(getCurrentBranch()).toBe("main");
    });
  });

  describe("isWorkingTreeDirty", () => {
    it("should return true when working tree has changes", () => {
      mockExecSync.mockReturnValue(" M file.ts");
      expect(isWorkingTreeDirty()).toBe(true);
    });

    it("should return false when working tree is clean", () => {
      mockExecSync.mockReturnValue("");
      expect(isWorkingTreeDirty()).toBe(false);
    });
  });

  describe("getDiff", () => {
    it("should return diff between two refs", () => {
      const expectedDiff = "diff --git a/file.ts b/file.ts\n...";
      mockExecSync.mockReturnValue(expectedDiff);
      expect(getDiff("main", "HEAD")).toBe(expectedDiff);
      expect(mockExecSync).toHaveBeenCalledWith("git", ["diff", "main...HEAD"], expect.any(Object));
    });
  });

  describe("getChangedFiles", () => {
    it("should parse numstat output correctly", () => {
      mockExecSync.mockReturnValue("10\t5\tsrc/file1.ts\n20\t0\tsrc/file2.ts");
      const files = getChangedFiles("main", "HEAD");
      expect(files).toHaveLength(2);
      expect(files[0]).toEqual({
        path: "src/file1.ts",
        status: "modified",
        additions: 10,
        deletions: 5,
      });
      expect(files[1]).toEqual({
        path: "src/file2.ts",
        status: "modified",
        additions: 20,
        deletions: 0,
      });
    });

    it("should return empty array when no changes", () => {
      mockExecSync.mockReturnValue("");
      expect(getChangedFiles("main", "HEAD")).toEqual([]);
    });

    it("should handle binary files with '-' additions/deletions", () => {
      mockExecSync.mockReturnValue("-\t-\tbinary.png");
      const files = getChangedFiles("main", "HEAD");
      expect(files).toHaveLength(1);
      expect(files[0]).toEqual({
        path: "binary.png",
        status: "modified",
        additions: 0,
        deletions: 0,
      });
    });

    it("should handle trailing newline correctly", () => {
      mockExecSync.mockReturnValue("10\t5\tsrc/file.ts\n");
      const files = getChangedFiles("main", "HEAD");
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("src/file.ts");
    });

    it("should call git with correct arguments", () => {
      mockExecSync.mockReturnValue("");
      getChangedFiles("base", "head");
      expect(mockExecSync).toHaveBeenCalledWith("git", ["diff", "--numstat", "base...head"], expect.any(Object));
    });
  });

  describe("getBaseCommit", () => {
    it("should return base commit hash", () => {
      mockExecSync.mockReturnValue("base123");
      expect(getBaseCommit("main")).toBe("base123");
      expect(mockExecSync).toHaveBeenCalledWith("git", ["rev-parse", "main"], expect.any(Object));
    });
  });

  describe("collectGitState", () => {
    it("should collect complete git state", () => {
      mockExecSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "main") return "base-commit-hash";
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "head-commit-hash";
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") return "main";
        if (args[0] === "status") return "";
        return "";
      });

      const state = collectGitState("main", "HEAD");
      expect(state).toEqual({
        baseRef: "main",
        headRef: "HEAD",
        baseCommit: "base-commit-hash",
        headCommit: "head-commit-hash",
        branch: "main",
        isDirty: false,
        timestamp: expect.any(String),
      });
    });

    it("should detect dirty working tree", () => {
      mockExecSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "main") return "base-hash";
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "head-hash";
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
        if (args[0] === "status") return " M file.ts";
        return "";
      });

      const state = collectGitState("main", "HEAD");
      expect(state.isDirty).toBe(true);
    });
  });

  describe("GitError", () => {
    it("should create error with correct name", () => {
      const error = new GitError("test error");
      expect(error.name).toBe("GitError");
      expect(error.message).toBe("test error");
    });
  });
});
