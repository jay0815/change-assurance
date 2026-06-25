import { describe, it, expect } from "vitest";
import {
  generateRunId,
  getRunDir,
  getInputDir,
  getInputArtifactPath,
  INPUT_ARTIFACTS,
} from "../artifact.js";

describe("artifact", () => {
  describe("generateRunId", () => {
    it("should generate a valid UUID", () => {
      const runId = generateRunId();
      expect(runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("should generate unique IDs", () => {
      const id1 = generateRunId();
      const id2 = generateRunId();
      expect(id1).not.toBe(id2);
    });
  });

  describe("getRunDir", () => {
    it("should return correct run directory path", () => {
      const runId = "test-run-id";
      expect(getRunDir(runId)).toBe(".change-assurance/runs/test-run-id");
    });
  });

  describe("getInputDir", () => {
    it("should return correct input directory path", () => {
      const runId = "test-run-id";
      expect(getInputDir(runId)).toBe(
        ".change-assurance/runs/test-run-id/input",
      );
    });
  });

  describe("getInputArtifactPath", () => {
    it("should return correct artifact path", () => {
      const runId = "test-run-id";
      const filename = "diff.patch";
      expect(getInputArtifactPath(runId, filename)).toBe(
        ".change-assurance/runs/test-run-id/input/diff.patch",
      );
    });
  });

  describe("INPUT_ARTIFACTS", () => {
    it("should have correct artifact names", () => {
      expect(INPUT_ARTIFACTS.INPUT_MANIFEST).toBe("input-manifest.json");
      expect(INPUT_ARTIFACTS.DIFF_PATCH).toBe("diff.patch");
      expect(INPUT_ARTIFACTS.CHANGED_FILES).toBe("changed-files.json");
      expect(INPUT_ARTIFACTS.GIT_STATE).toBe("git-state.json");
      expect(INPUT_ARTIFACTS.POLICY_SNAPSHOT).toBe("policy.snapshot.yaml");
    });
  });
});
