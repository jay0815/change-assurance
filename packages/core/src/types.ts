export interface InputManifest {
  runId: string;
  baseRef: string;
  headRef: string;
  createdAt: string;
  policySnapshotHash: string;
  diffHash: string;
  changedFilesHash: string;
  gitStateHash: string;
}

export interface GitState {
  baseRef: string;
  headRef: string;
  baseCommit: string;
  headCommit: string;
  branch: string;
  isDirty: boolean;
  timestamp: string;
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  oldPath?: string;
}

export interface ReviewRun {
  runId: string;
  baseRef: string;
  headRef: string;
  createdAt: string;
  status: "created" | "verified" | "reviewed" | "completed";
}
