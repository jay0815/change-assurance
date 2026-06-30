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
      buildClaudeArgs(input.schema),
      {
        cwd: input.runDirectory,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        input: input.prompt,
      },
    );

    if (result.status !== 0) {
      throw new AdapterError(`Claude CLI failed: ${extractFailureMessage(result.stdout, result.stderr)}`);
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
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (typeof msg !== "object" || msg === null) continue;
      if ("structured_output" in msg) {
        return (msg as any).structured_output;
      }
    }

    let structuredOutput: unknown;

    // Claude may emit an invalid StructuredOutput and then repair it in a later turn.
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
            structuredOutput = (block as any).input;
          }
        }
      }
    }

    if (structuredOutput !== undefined) {
      return structuredOutput;
    }

    throw new AdapterError("No StructuredOutput found in Claude CLI output");
  }
}

function buildClaudeArgs(schema: object): string[] {
  const args = ["--bare", "--tools", "", "-p", "--output-format", "stream-json", "--json-schema", JSON.stringify(schema)];
  const settingsPath = process.env.CHANGE_ASSURANCE_CLAUDE_SETTINGS?.trim();
  if (!settingsPath) return args;
  return ["--settings", settingsPath, ...args];
}

function extractFailureMessage(stdout: string | Buffer | null | undefined, stderr: string | Buffer | null | undefined): string {
  const stderrText = String(stderr ?? "").trim();
  if (stderrText) return stderrText;

  const stdoutText = String(stdout ?? "").trim();
  if (!stdoutText) return "";

  try {
    const lines = stdoutText.split("\n").filter((line) => line.trim() !== "");
    for (let i = lines.length - 1; i >= 0; i--) {
      const parsed = JSON.parse(lines[i]);
      if (typeof parsed?.result === "string" && parsed.result.trim() !== "") {
        return parsed.result.trim();
      }
      if (typeof parsed?.error === "string" && parsed.error.trim() !== "") {
        return parsed.error.trim();
      }
    }
  } catch {
    return stdoutText;
  }

  return stdoutText;
}
