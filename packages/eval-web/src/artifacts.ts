import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

export type CellStatus = "not-run" | "pasted" | "valid" | "invalid" | "parse_error";
export type PromptStatus = "rendered" | "placeholder" | "missing";

export interface EvalDimensions {
  cases: number;
  roles: number;
  prompts: number;
  models: number;
  attempts: number;
}

export interface EvalCellArtifactPaths {
  prompt?: string;
  rawOutput?: string;
  normalizedOutput?: string;
  score?: string;
  metadata?: string;
}

export interface EvalMatrixCell {
  id: string;
  runId?: string;
  caseId: string;
  roleId: string;
  promptId: string;
  promptVersion?: string;
  modelId: string;
  provider?: string;
  settingRef?: string;
  attempt: number;
  workspaceRef?: string;
  promptTemplateRef?: string;
  artifactDir?: string;
  artifacts?: EvalCellArtifactPaths;
  executed?: boolean;
}

export interface EvalCellView extends EvalMatrixCell {
  status: CellStatus;
  promptStatus: PromptStatus;
  promptText: string;
}

export interface EvalSummary {
  runId: string;
  mode: string;
  executed: boolean;
  totalCells: number;
  dimensions: EvalDimensions;
}

export interface EvalRunView {
  outputDir: string;
  summary: EvalSummary;
  cells: EvalCellView[];
  artifacts: {
    matrix: boolean;
    summary: boolean;
    resultsSkeleton: boolean;
    commandsPreview: boolean;
    promptfooConfigPreview: boolean;
  };
}

export interface PastedOutputValidation {
  status: "valid" | "invalid" | "parse_error";
  format: "json" | "jsonl" | "unknown";
  message: string;
  parsedItems: number;
  result: "pass" | "fail" | "unknown";
  errors: string[];
}

interface MatrixArtifact {
  runId: string;
  mode: string;
  executed: boolean;
  dimensions: EvalDimensions;
  cells: EvalMatrixCell[];
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function resolveArtifactPath(
  outputDir: string,
  artifactPath: string | undefined,
): string | undefined {
  if (!artifactPath) {
    return undefined;
  }
  return resolve(outputDir, artifactPath);
}

function readPromptText(
  outputDir: string,
  cell: EvalMatrixCell,
): Pick<EvalCellView, "promptStatus" | "promptText"> {
  const promptPath = resolveArtifactPath(outputDir, cell.artifacts?.prompt);
  if (promptPath && existsSync(promptPath)) {
    return {
      promptStatus: "rendered",
      promptText: readFileSync(promptPath, "utf-8"),
    };
  }

  if (cell.promptTemplateRef) {
    return {
      promptStatus: "placeholder",
      promptText: cell.promptTemplateRef,
    };
  }

  return {
    promptStatus: "missing",
    promptText: "",
  };
}

export function loadEvalRun(outputDirInput: string): EvalRunView {
  const outputDir = resolve(outputDirInput);
  const matrixPath = join(outputDir, "matrix.json");
  const summaryPath = join(outputDir, "summary.json");
  const resultsSkeletonPath = join(outputDir, "results.skeleton.json");
  const commandsPreviewPath = join(outputDir, "commands.preview.json");
  const promptfooPreviewPath = join(outputDir, "promptfoo.config.preview.yaml");

  if (!existsSync(matrixPath)) {
    throw new Error(`matrix.json not found: ${matrixPath}`);
  }
  if (!existsSync(summaryPath)) {
    throw new Error(`summary.json not found: ${summaryPath}`);
  }

  const matrix = readJsonFile<MatrixArtifact>(matrixPath);
  const summary = readJsonFile<EvalSummary>(summaryPath);

  return {
    outputDir,
    summary,
    cells: matrix.cells.map((cell) => {
      const prompt = readPromptText(outputDir, cell);
      return {
        ...cell,
        status: "not-run",
        promptStatus: prompt.promptStatus,
        promptText: prompt.promptText,
      };
    }),
    artifacts: {
      matrix: true,
      summary: true,
      resultsSkeleton: existsSync(resultsSkeletonPath),
      commandsPreview: existsSync(commandsPreviewPath),
      promptfooConfigPreview: existsSync(promptfooPreviewPath),
    },
  };
}

function parseJsonLines(text: string): unknown[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new Error("JSONL requires at least two non-empty lines");
  }
  return lines.map((line) => JSON.parse(line));
}

function deriveResult(parsed: unknown): "pass" | "fail" | "unknown" {
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const text = JSON.stringify(values).toLowerCase();
  if (text.includes('"pass"') || text.includes('"passed"') || text.includes('"success"')) {
    return "pass";
  }
  if (text.includes('"fail"') || text.includes('"failed"') || text.includes('"error"')) {
    return "fail";
  }
  return "unknown";
}

export function validatePastedOutput(text: string): PastedOutputValidation {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      status: "invalid",
      format: "unknown",
      message: "Output is empty",
      parsedItems: 0,
      result: "unknown",
      errors: ["empty_output"],
    };
  }

  try {
    const parsed = JSON.parse(trimmed);
    return {
      status: "valid",
      format: "json",
      message: "Valid JSON",
      parsedItems: 1,
      result: deriveResult(parsed),
      errors: [],
    };
  } catch {
    try {
      const parsed = parseJsonLines(trimmed);
      return {
        status: "valid",
        format: "jsonl",
        message: "Valid JSONL",
        parsedItems: parsed.length,
        result: deriveResult(parsed),
        errors: [],
      };
    } catch (error) {
      return {
        status: "parse_error",
        format: "unknown",
        message: error instanceof Error ? error.message : String(error),
        parsedItems: 0,
        result: "unknown",
        errors: ["parse_error"],
      };
    }
  }
}
