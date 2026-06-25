import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VerifyError } from "../review-verify.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import * as core from "@change-assurance/core";

vi.mock("@change-assurance/core", async () => {
  const actual = await vi.importActual("@change-assurance/core");
  return {
    ...actual,
    getHeadCommit: vi.fn(),
    isWorkingTreeDirty: vi.fn(),
  };
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("reviewVerify", () => {
  let tempDir: string;
  let originalCwd: string;
  let mockGetHeadCommit: ReturnType<typeof vi.fn>;
  let mockIsWorkingTreeDirty: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "change-assurance-verify-test-"));
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

  function createRunFixture(options?: {
    headCommit?: string;
    dirty?: boolean;
    policy?: any;
    changedFiles?: any[];
  }) {
    const runId = "test-run";
    const headCommit = options?.headCommit ?? "abc123";
    const dirty = options?.dirty ?? false;

    const policy = options?.policy ?? {
      version: 1,
      verification: {
        commands: [
          {
            id: "typecheck",
            argv: ["echo", "typecheck"],
            when: { pathsAny: ["**/*.ts"] },
          },
        ],
      },
    };

    const changedFiles = options?.changedFiles ?? [
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
    const diff = "diff content";

    const policySnapshot = stringify(policy);
    const changedFilesJson = JSON.stringify(changedFiles, null, 2);
    const gitStateJson = JSON.stringify(gitState, null, 2);

    const manifest = {
      runId,
      baseRef: "main",
      headRef: "HEAD",
      createdAt: "2024-01-01T00:00:00.000Z",
      policySnapshotHash: sha256(policySnapshot),
      diffHash: sha256(diff),
      changedFilesHash: sha256(changedFilesJson),
      gitStateHash: sha256(gitStateJson),
    };

    const inputDir = join(tempDir, ".change-assurance", "runs", runId, "input");
    mkdirSync(inputDir, { recursive: true });

    writeFileSync(join(inputDir, "input-manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(inputDir, "diff.patch"), diff);
    writeFileSync(join(inputDir, "changed-files.json"), changedFilesJson);
    writeFileSync(join(inputDir, "git-state.json"), gitStateJson);
    writeFileSync(join(inputDir, "policy.snapshot.yaml"), policySnapshot);

    mockGetHeadCommit.mockReturnValue(headCommit);
    mockIsWorkingTreeDirty.mockReturnValue(dirty);

    return runId;
  }

  it("should throw VerifyError when run not found", async () => {
    const { reviewVerify } = await import("../review-verify.js");
    expect(() => reviewVerify({ runId: "nonexistent" })).toThrow(VerifyError);
  });

  it("should block when HEAD changed after prepare", async () => {
    const runId = createRunFixture({ headCommit: "original-commit" });
    mockGetHeadCommit.mockReturnValue("different-commit");

    const { reviewVerify } = await import("../review-verify.js");
    const ledger = reviewVerify({ runId });

    expect(ledger.runStatus).toBe("blocked");
    expect(ledger.preconditionErrors.some((err) => err.includes("HEAD changed"))).toBe(true);
  });

  it("should block when working tree is dirty", async () => {
    const runId = createRunFixture({ dirty: true });

    const { reviewVerify } = await import("../review-verify.js");
    const ledger = reviewVerify({ runId });

    expect(ledger.runStatus).toBe("blocked");
    expect(ledger.preconditionErrors).toContain("Git working tree is dirty");
  });

  it("should execute commands that match pathsAny", async () => {
    const runId = createRunFixture({
      policy: {
        version: 1,
        verification: {
          commands: [
            { id: "typecheck", argv: ["echo", "typecheck"], when: { pathsAny: ["**/*.ts"] } },
          ],
        },
      },
    });

    const { reviewVerify } = await import("../review-verify.js");
    const ledger = reviewVerify({ runId });

    expect(ledger.runStatus).toBe("completed");
    expect(ledger.commands).toHaveLength(1);
    expect(ledger.commands[0].status).toBe("passed");
    expect(ledger.commands[0].exitCode).toBe(0);
  });

  it("should mark commands as not_required when pathsAny not matched", async () => {
    const runId = createRunFixture({
      policy: {
        version: 1,
        verification: {
          commands: [
            { id: "typecheck", argv: ["echo", "typecheck"], when: { pathsAny: ["**/*.py"] } },
          ],
        },
      },
    });

    const { reviewVerify } = await import("../review-verify.js");
    const ledger = reviewVerify({ runId });

    expect(ledger.commands[0].status).toBe("not_required");
    expect(ledger.summary.notRequired).toBe(1);
  });

  it("should record failed commands", async () => {
    const runId = createRunFixture({
      policy: {
        version: 1,
        verification: {
          commands: [
            { id: "fail-cmd", argv: ["node", "-e", "process.exit(1)"], when: { pathsAny: ["**/*.ts"] } },
          ],
        },
      },
    });

    const { reviewVerify } = await import("../review-verify.js");
    const ledger = reviewVerify({ runId });

    expect(ledger.commands[0].status).toBe("failed");
    expect(ledger.commands[0].exitCode).toBe(1);
    expect(ledger.summary.failed).toBe(1);
  });
});
