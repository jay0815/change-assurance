import { spawnSync } from "node:child_process";

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

export interface AdapterCapabilities {
  available: boolean;
  version?: string;
  supportsJsonOutput: boolean;
  supportsJsonSchema: boolean;
}

export interface RunStageInput {
  stage: string;
  runDirectory: string;
  prompt: string;
  schema: object;
}

export interface RunStageOutput {
  rawOutput: unknown;
  structuredOutput: unknown;
}

export class ClaudeAdapter {
  detectCapabilities(): AdapterCapabilities {
    try {
      const result = spawnSync("claude", ["--version"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (result.status !== 0) {
        return { available: false, supportsJsonOutput: false, supportsJsonSchema: false };
      }

      const version = result.stdout?.trim().split(" ")[0] ?? "";
      return {
        available: true,
        version,
        supportsJsonOutput: true,
        supportsJsonSchema: true,
      };
    } catch {
      return { available: false, supportsJsonOutput: false, supportsJsonSchema: false };
    }
  }

  async runStage(input: RunStageInput): Promise<RunStageOutput> {
    const caps = this.detectCapabilities();
    if (!caps.available) {
      throw new AdapterError("Claude CLI not available");
    }

    const result = spawnSync(
      "claude",
      ["-p", "--output-format", "stream-json", "--json-schema", JSON.stringify(input.schema)],
      {
        cwd: input.runDirectory,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        input: input.prompt,
      },
    );

    if (result.status !== 0) {
      throw new AdapterError(`Claude CLI failed: ${result.stderr}`);
    }

    try {
      const stdout = (result.stdout ?? "").trim();
      let rawOutput: unknown[];

      // Try parsing as JSON array first
      if (stdout.startsWith("[")) {
        rawOutput = JSON.parse(stdout);
      } else {
        // stream-json format is one JSON object per line (NDJSON)
        const lines = stdout.split("\n").filter((line) => line.trim() !== "");
        rawOutput = lines.map((line) => JSON.parse(line));
      }

      // Extract structured output from stream-json format
      const structuredOutput = this.extractStructuredOutput(rawOutput);
      return { rawOutput, structuredOutput };
    } catch {
      throw new AdapterError("Failed to parse Claude CLI output as JSON");
    }
  }

  private extractStructuredOutput(messages: unknown[]): unknown {
    // Find the assistant message with StructuredOutput tool use
    for (const msg of messages) {
      if (typeof msg !== "object" || msg === null) continue;

      // Check for assistant type with message field
      if ("type" in msg && (msg as any).type === "assistant" && "message" in msg) {
        const message = (msg as any).message;
        if (typeof message !== "object" || message === null) continue;

        // Check for content array
        if (!("content" in message) || !Array.isArray(message.content)) continue;

        for (const block of message.content) {
          if (typeof block !== "object" || block === null) continue;

          // Check for tool_use with StructuredOutput
          if (
            "type" in block &&
            (block as any).type === "tool_use" &&
            "name" in block &&
            (block as any).name === "StructuredOutput" &&
            "input" in block
          ) {
            return (block as any).input;
          }
        }
      }
    }
    throw new AdapterError("No StructuredOutput found in Claude CLI output");
  }
}
