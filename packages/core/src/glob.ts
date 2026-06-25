// Simple glob pattern matching for pathsAny
// Supports: **, *, ?, literal segments
export function minimatch(filePath: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{DOUBLE_STAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/{{DOUBLE_STAR}}/g, ".*");

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(filePath);
}
