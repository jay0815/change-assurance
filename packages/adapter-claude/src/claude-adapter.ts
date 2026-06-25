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
      ["-p", "--output-format", "json", "--json-schema", JSON.stringify(input.schema)],
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
      const rawOutput = JSON.parse(result.stdout ?? "{}");
      return { rawOutput, structuredOutput: rawOutput };
    } catch {
      throw new AdapterError("Failed to parse Claude CLI output as JSON");
    }
  }
}
