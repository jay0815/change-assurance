import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeAdapter, AdapterError } from "../claude-adapter.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

describe("ClaudeAdapter", () => {
  let adapter: ClaudeAdapter;
  let mockSpawnSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const childProcess = await import("node:child_process");
    mockSpawnSync = vi.mocked(childProcess.spawnSync);
    mockSpawnSync.mockReset();
    adapter = new ClaudeAdapter();
  });

  describe("detectCapabilities", () => {
    it("should detect Claude CLI capabilities", () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: "2.1.153 (Claude Code)",
        stderr: "",
      });

      const caps = adapter.detectCapabilities();
      expect(caps.available).toBe(true);
      expect(caps.version).toBe("2.1.153");
    });

    it("should return unavailable when Claude CLI not found", () => {
      mockSpawnSync.mockImplementation(() => {
        throw new Error("command not found");
      });

      const caps = adapter.detectCapabilities();
      expect(caps.available).toBe(false);
    });
  });

  describe("runStage", () => {
    it("should throw AdapterError when Claude CLI not available", async () => {
      mockSpawnSync.mockImplementation(() => {
        throw new Error("command not found");
      });

      await expect(
        adapter.runStage({
          stage: "change-map",
          runDirectory: "/tmp/test",
          prompt: "test",
          schema: {},
        }),
      ).rejects.toThrow(AdapterError);
    });

    it("should return structured output on success", async () => {
      const structuredData = {
        changedModules: [],
        behaviorChanges: [],
        riskAreas: [],
        reviewPriorities: [],
        uncoveredContext: [],
        assumptions: [],
      };
      const mockOutput = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "StructuredOutput", input: structuredData }],
        },
      });

      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: mockOutput,
        stderr: "",
      });

      const result = await adapter.runStage({
        stage: "change-map",
        runDirectory: "/tmp/test",
        prompt: "test prompt",
        schema: { type: "object" },
      });

      expect(result.rawOutput).toBeDefined();
      expect(result.structuredOutput).toEqual(structuredData);
    });

    it("should throw AdapterError on non-zero exit", async () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "error message",
      });

      await expect(
        adapter.runStage({
          stage: "change-map",
          runDirectory: "/tmp/test",
          prompt: "test",
          schema: {},
        }),
      ).rejects.toThrow(AdapterError);
    });
  });
});
