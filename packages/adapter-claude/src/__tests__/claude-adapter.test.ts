import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaudeAdapter, AdapterError } from "../claude-adapter.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

describe("ClaudeAdapter", () => {
  let adapter: ClaudeAdapter;
  let mockSpawnSync: ReturnType<typeof vi.fn>;
  let originalSettingsPath: string | undefined;

  beforeEach(async () => {
    const childProcess = await import("node:child_process");
    mockSpawnSync = vi.mocked(childProcess.spawnSync);
    mockSpawnSync.mockReset();
    originalSettingsPath = process.env.CHANGE_ASSURANCE_CLAUDE_SETTINGS;
    delete process.env.CHANGE_ASSURANCE_CLAUDE_SETTINGS;
    adapter = new ClaudeAdapter();
  });

  afterEach(() => {
    if (originalSettingsPath === undefined) {
      delete process.env.CHANGE_ASSURANCE_CLAUDE_SETTINGS;
    } else {
      process.env.CHANGE_ASSURANCE_CLAUDE_SETTINGS = originalSettingsPath;
    }
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

    it("should prefer final result structured_output over earlier tool_use output", async () => {
      const invalidFirstOutput = { reviewedBehaviors: "[{\"behavior\":\"bad\"}]" };
      const finalStructuredOutput = { reviewedBehaviors: [{ behavior: "good" }] };
      const mockOutput = [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "StructuredOutput", input: invalidFirstOutput },
            ],
          },
        }),
        JSON.stringify({
          type: "result",
          structured_output: finalStructuredOutput,
        }),
      ].join("\n");

      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: mockOutput,
        stderr: "",
      });

      const result = await adapter.runStage({
        stage: "test-review",
        runDirectory: "/tmp/test",
        prompt: "test prompt",
        schema: { type: "object" },
      });

      expect(result.structuredOutput).toEqual(finalStructuredOutput);
    });

    it("should use the last StructuredOutput tool input when no result structured_output exists", async () => {
      const invalidFirstOutput = { reviewedBehaviors: "[{\"behavior\":\"bad\"}]" };
      const correctedOutput = { reviewedBehaviors: [{ behavior: "good" }] };
      const mockOutput = [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "StructuredOutput", input: invalidFirstOutput },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "StructuredOutput", input: correctedOutput },
            ],
          },
        }),
      ].join("\n");

      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: mockOutput,
        stderr: "",
      });

      const result = await adapter.runStage({
        stage: "test-review",
        runDirectory: "/tmp/test",
        prompt: "test prompt",
        schema: { type: "object" },
      });

      expect(result.structuredOutput).toEqual(correctedOutput);
    });

    it("should pass configured settings path to Claude CLI", async () => {
      process.env.CHANGE_ASSURANCE_CLAUDE_SETTINGS = "/tmp/change-assurance-claude-settings.json";
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
          content: [
            { type: "tool_use", name: "StructuredOutput", input: structuredData },
          ],
        },
      });

      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: mockOutput,
        stderr: "",
      });

      await adapter.runStage({
        stage: "change-map",
        runDirectory: "/tmp/test",
        prompt: "test prompt",
        schema: { type: "object" },
      });

      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        "claude",
        expect.arrayContaining(["--settings", "/tmp/change-assurance-claude-settings.json"]),
        expect.any(Object),
      );
    });

    it("should run stages in bare mode with tools disabled", async () => {
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
          content: [
            { type: "tool_use", name: "StructuredOutput", input: structuredData },
          ],
        },
      });

      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: mockOutput,
        stderr: "",
      });

      await adapter.runStage({
        stage: "change-map",
        runDirectory: "/tmp/test",
        prompt: "test prompt",
        schema: { type: "object" },
      });

      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        "claude",
        expect.arrayContaining(["--bare", "--tools", ""]),
        expect.any(Object),
      );
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

    it("should include stdout result when Claude exits non-zero without stderr", async () => {
      mockSpawnSync
        .mockReturnValueOnce({
          status: 0,
          stdout: "2.1.153 (Claude Code)",
          stderr: "",
        })
        .mockReturnValueOnce({
          status: 1,
          stdout: JSON.stringify({
            type: "result",
            is_error: true,
            result: "Not logged in",
          }),
          stderr: "",
        });

      await expect(
        adapter.runStage({
          stage: "change-map",
          runDirectory: "/tmp/test",
          prompt: "test",
          schema: {},
        }),
      ).rejects.toThrow("Not logged in");
    });
  });
});
