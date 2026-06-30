import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEvalRun, validatePastedOutput } from "../artifacts.js";

describe("eval web artifacts", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "change-assurance-eval-web-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads dry-run artifacts and returns cells with prompt placeholders", () => {
    const outputDir = join(tempDir, ".harness-eval", "sample-run");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(outputDir, "matrix.json"),
      JSON.stringify({
        runId: "sample-run",
        mode: "dry-run",
        executed: false,
        dimensions: { cases: 1, roles: 1, prompts: 1, models: 1, attempts: 1 },
        cells: [
          {
            id: "case__role__prompt__model__attempt-1",
            caseId: "case",
            roleId: "role",
            promptId: "prompt",
            promptVersion: "v1",
            modelId: "model",
            attempt: 1,
            promptTemplateRef: "prompts/baseline.md",
            artifacts: { prompt: "runs/sample/cell/prompt.md" },
            executed: false,
          },
        ],
      }),
    );
    writeFileSync(
      join(outputDir, "summary.json"),
      JSON.stringify({
        runId: "sample-run",
        mode: "dry-run",
        executed: false,
        totalCells: 1,
        dimensions: { cases: 1, roles: 1, prompts: 1, models: 1, attempts: 1 },
      }),
    );
    writeFileSync(
      join(outputDir, "results.skeleton.json"),
      JSON.stringify({ mode: "dry-run", executed: false, results: [] }),
    );

    const run = loadEvalRun(outputDir);

    expect(run.summary.totalCells).toBe(1);
    expect(run.cells[0]).toMatchObject({
      id: "case__role__prompt__model__attempt-1",
      status: "not-run",
      promptStatus: "placeholder",
      promptTemplateRef: "prompts/baseline.md",
    });
  });

  it("validates pasted JSON and stream JSON text", () => {
    expect(validatePastedOutput('{"result":"ok"}')).toMatchObject({
      status: "valid",
      format: "json",
    });
    expect(validatePastedOutput('{"type":"start"}\n{"type":"result","ok":true}')).toMatchObject({
      status: "valid",
      format: "jsonl",
    });
    expect(validatePastedOutput("not json")).toMatchObject({
      status: "parse_error",
      format: "unknown",
    });
  });
});
