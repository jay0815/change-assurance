---
name: implement
description: Implement features following strict TDD workflow
---

# Implement Skill (TDD)

When implementing any feature or bugfix, follow this strict TDD workflow:

## 1. Write Failing Test First

Before writing any implementation code:

- Create or identify the test file
- Write a test that describes the expected behavior
- Run the test and confirm it fails

```bash
pnpm test -- --filter <package> <test-file>
```

## 2. Implement Minimum Code

Write only enough code to make the failing test pass:

- No extra features
- No premature optimization
- No "nice to have" additions

## 3. Verify Test Passes

Run the test again:

```bash
pnpm test -- --filter <package> <test-file>
```

Confirm the test passes.

## 4. Refactor (If Needed)

Only after the test passes:

- Clean up code
- Improve naming
- Remove duplication

Run tests again after refactoring to ensure nothing broke.

## 5. Verify Full Suite

Before considering implementation complete:

```bash
pnpm typecheck
pnpm test
```

## Constraints

- Never write implementation before test
- Never skip the failing test step
- Never add untested features
- Each test should verify one behavior
