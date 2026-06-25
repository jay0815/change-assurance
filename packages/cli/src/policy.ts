import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

export interface PolicyConfig {
  defaultBaseRef?: string;
  verificationCommands?: VerificationCommand[];
  ignorePaths?: string[];
}

export interface VerificationCommand {
  id: string;
  name: string;
  command: string;
  required: boolean;
}

const POLICY_FILE = "change-assurance.yaml";

export function loadPolicy(cwd: string): PolicyConfig {
  const policyPath = resolve(cwd, POLICY_FILE);
  try {
    const content = readFileSync(policyPath, "utf-8");
    return parse(content) as PolicyConfig;
  } catch {
    return {};
  }
}
