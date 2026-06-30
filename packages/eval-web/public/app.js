const state = {
  run: null,
  selectedCellId: null,
  cellResults: new Map(),
  activeTab: "prompt",
};

const elements = {
  loadForm: document.querySelector("#loadForm"),
  outputDir: document.querySelector("#outputDir"),
  configPath: document.querySelector("#configPath"),
  runMeta: document.querySelector("#runMeta"),
  metricTotal: document.querySelector("#metricTotal"),
  metricPasted: document.querySelector("#metricPasted"),
  metricValid: document.querySelector("#metricValid"),
  metricInvalid: document.querySelector("#metricInvalid"),
  metricPass: document.querySelector("#metricPass"),
  metricFail: document.querySelector("#metricFail"),
  artifactMatrix: document.querySelector("#artifactMatrix"),
  artifactSummary: document.querySelector("#artifactSummary"),
  artifactResults: document.querySelector("#artifactResults"),
  artifactCommands: document.querySelector("#artifactCommands"),
  artifactPromptfoo: document.querySelector("#artifactPromptfoo"),
  modelFilter: document.querySelector("#modelFilter"),
  statusFilter: document.querySelector("#statusFilter"),
  matrixBody: document.querySelector("#matrixBody"),
  detailPanel: document.querySelector("#detailPanel"),
  emptyView: document.querySelector("#emptyView"),
  cellTitle: document.querySelector("#cellTitle"),
  cellSubtitle: document.querySelector("#cellSubtitle"),
  cellStatus: document.querySelector("#cellStatus"),
  promptStatus: document.querySelector("#promptStatus"),
  promptText: document.querySelector("#promptText"),
  outputText: document.querySelector("#outputText"),
  validateOutput: document.querySelector("#validateOutput"),
  validationMessage: document.querySelector("#validationMessage"),
  copyPrompt: document.querySelector("#copyPrompt"),
  tabPrompt: document.querySelector("#tabPrompt"),
  tabOutput: document.querySelector("#tabOutput"),
  promptView: document.querySelector("#promptView"),
  outputView: document.querySelector("#outputView"),
};

function storageKey() {
  return `change-assurance:eval-web:${elements.outputDir.value}`;
}

function loadSavedResults() {
  state.cellResults = new Map();
  const raw = localStorage.getItem(storageKey());
  if (!raw) return;
  try {
    const entries = JSON.parse(raw);
    state.cellResults = new Map(entries);
  } catch {
    state.cellResults = new Map();
  }
}

function saveResults() {
  localStorage.setItem(storageKey(), JSON.stringify([...state.cellResults.entries()]));
}

function getCellStatus(cell) {
  return state.cellResults.get(cell.id)?.validation?.status ?? cell.status;
}

function setPill(element, status) {
  element.className = `status-pill ${status}`;
  element.textContent = status;
}

function setArtifact(element, present) {
  element.classList.toggle("present", Boolean(present));
}

function renderMetrics() {
  const cells = state.run?.cells ?? [];
  const values = {
    total: cells.length,
    pasted: 0,
    valid: 0,
    invalid: 0,
    pass: 0,
    fail: 0,
  };

  for (const cell of cells) {
    const result = state.cellResults.get(cell.id);
    if (!result) continue;
    values.pasted += 1;
    if (result.validation?.status === "valid") values.valid += 1;
    if (result.validation?.status === "invalid" || result.validation?.status === "parse_error") {
      values.invalid += 1;
    }
    if (result.validation?.result === "pass") values.pass += 1;
    if (result.validation?.result === "fail") values.fail += 1;
  }

  elements.metricTotal.textContent = String(values.total);
  elements.metricPasted.textContent = String(values.pasted);
  elements.metricValid.textContent = String(values.valid);
  elements.metricInvalid.textContent = String(values.invalid);
  elements.metricPass.textContent = String(values.pass);
  elements.metricFail.textContent = String(values.fail);
}

function filteredCells() {
  const cells = state.run?.cells ?? [];
  const model = elements.modelFilter.value;
  const status = elements.statusFilter.value;
  return cells.filter((cell) => {
    if (model && cell.modelId !== model) return false;
    if (status && getCellStatus(cell) !== status) return false;
    return true;
  });
}

function renderModelFilter() {
  const models = [...new Set((state.run?.cells ?? []).map((cell) => cell.modelId))].sort();
  elements.modelFilter.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All";
  elements.modelFilter.append(all);
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    elements.modelFilter.append(option);
  }
}

function renderMatrix() {
  elements.matrixBody.replaceChildren();
  const cells = filteredCells();
  if (cells.length === 0) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    const td = document.createElement("td");
    td.colSpan = 6;
    td.textContent = state.run ? "No cells match the current filters" : "No run loaded";
    row.append(td);
    elements.matrixBody.append(row);
    return;
  }

  for (const cell of cells) {
    const row = document.createElement("tr");
    row.classList.toggle("selected", cell.id === state.selectedCellId);
    row.addEventListener("click", () => {
      state.selectedCellId = cell.id;
      render();
    });

    const values = [
      cell.caseId,
      cell.roleId,
      `${cell.promptId}${cell.promptVersion ? `/${cell.promptVersion}` : ""}`,
      cell.modelId,
      String(cell.attempt),
      getCellStatus(cell),
    ];

    for (const value of values) {
      const td = document.createElement("td");
      td.textContent = value;
      td.title = value;
      row.append(td);
    }
    elements.matrixBody.append(row);
  }
}

function selectedCell() {
  return (state.run?.cells ?? []).find((cell) => cell.id === state.selectedCellId) ?? null;
}

function renderDetail() {
  const cell = selectedCell();
  elements.detailPanel.classList.toggle("empty", !cell);
  if (!cell) {
    elements.cellTitle.textContent = "No Cell";
    elements.cellSubtitle.textContent = state.run ? "Select a cell" : "Load a run";
    setPill(elements.cellStatus, "not-run");
    elements.promptStatus.textContent = "missing";
    elements.promptStatus.className = "";
    elements.promptText.textContent = "No prompt";
    elements.outputText.value = "";
    elements.validationMessage.textContent = "not-run";
    elements.validationMessage.className = "";
    elements.emptyView.querySelector("strong").textContent = state.run
      ? "No cell selected"
      : "No run loaded";
    elements.emptyView.querySelector("span").textContent = state.run
      ? "Select a matrix row to inspect the prompt and paste model output."
      : "Load a dry-run output directory to inspect the evaluation matrix.";
    return;
  }

  const result = state.cellResults.get(cell.id);
  const status = getCellStatus(cell);
  elements.cellTitle.textContent = cell.id;
  elements.cellSubtitle.textContent = `${cell.caseId} · ${cell.roleId} · ${cell.modelId}`;
  setPill(elements.cellStatus, status);
  elements.promptStatus.textContent = cell.promptStatus;
  elements.promptStatus.className = cell.promptStatus;
  elements.promptText.textContent = cell.promptText;
  elements.outputText.value = result?.text ?? "";
  elements.validationMessage.textContent = result?.validation?.message ?? "not-run";
  elements.validationMessage.className = result?.validation?.status ?? "";
}

function renderArtifacts() {
  const artifacts = state.run?.artifacts ?? {};
  setArtifact(elements.artifactMatrix, artifacts.matrix);
  setArtifact(elements.artifactSummary, artifacts.summary);
  setArtifact(elements.artifactResults, artifacts.resultsSkeleton);
  setArtifact(elements.artifactCommands, artifacts.commandsPreview);
  setArtifact(elements.artifactPromptfoo, artifacts.promptfooConfigPreview);
}

function renderTabs() {
  elements.tabPrompt.classList.toggle("active", state.activeTab === "prompt");
  elements.tabOutput.classList.toggle("active", state.activeTab === "output");
  elements.promptView.classList.toggle("active", state.activeTab === "prompt");
  elements.outputView.classList.toggle("active", state.activeTab === "output");
}

function render() {
  if (state.run) {
    elements.runMeta.textContent = `${state.run.summary.runId} · ${state.run.summary.mode} · ${state.run.summary.totalCells} cells`;
  }
  renderMetrics();
  renderArtifacts();
  renderMatrix();
  renderDetail();
  renderTabs();
}

async function loadRun() {
  const outputDir = elements.outputDir.value.trim();
  const response = await fetch(`/api/run?outputDir=${encodeURIComponent(outputDir)}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? "Load failed");
  }
  state.run = payload;
  loadSavedResults();
  state.selectedCellId = payload.cells[0]?.id ?? null;
  renderModelFilter();
  render();
}

async function validateSelectedOutput() {
  const cell = selectedCell();
  if (!cell) return;
  const text = elements.outputText.value;
  const response = await fetch("/api/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cellId: cell.id, text }),
  });
  const validation = await response.json();
  state.cellResults.set(cell.id, {
    text,
    validation,
    updatedAt: new Date().toISOString(),
  });
  saveResults();
  render();
}

elements.loadForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadRun().catch((error) => {
    elements.runMeta.textContent = error.message;
  });
});

elements.modelFilter.addEventListener("change", renderMatrix);
elements.statusFilter.addEventListener("change", renderMatrix);
elements.validateOutput.addEventListener("click", () => {
  validateSelectedOutput().catch((error) => {
    elements.validationMessage.textContent = error.message;
    elements.validationMessage.className = "parse_error";
  });
});
elements.copyPrompt.addEventListener("click", () => {
  void navigator.clipboard.writeText(elements.promptText.textContent ?? "");
});
elements.tabPrompt.addEventListener("click", () => {
  state.activeTab = "prompt";
  renderTabs();
});
elements.tabOutput.addEventListener("click", () => {
  state.activeTab = "output";
  renderTabs();
});

render();
