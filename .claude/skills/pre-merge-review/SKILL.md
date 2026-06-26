---
name: pre-merge-review
description: Run pre-merge review using ca review run
---

# Pre-Merge Review Skill

When the user requests a pre-merge review, follow these steps:

## 1. Parse User Input

Extract the `--base` parameter from user input:
- If provided: use it as the base reference
- If not provided: let `ca` use its default strategy (typically `origin/main`)

## 2. Execute Review

Run the review command:

```bash
pnpm ca review run --base <ref> --engine claude --dry-run
```

Where `<ref>` is the user-provided base reference or omitted for default.

## 3. Display Results

Read and display the CLI output:
- Run ID
- Decision (ready_to_merge, not_ready_to_merge, etc.)
- Report path
- Verification summary (passed/failed counts)
- Issue summary (blocking, material, needs_context counts)

## 4. Guide User

Direct the user to the formal report path for detailed review.

## Constraints

**DO NOT:**
- Run individual stage commands (prepare, verify, etc.) separately
- Explain the diff and form formal review conclusions
- Bypass `ca review run`
- Claim verification has passed unless from the run report

**DO:**
- Call `pnpm ca review run` as the single entry point
- Display the CLI output as-is
- Guide user to the formal report path
