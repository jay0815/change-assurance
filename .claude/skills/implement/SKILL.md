---
name: implement
description: Implement features following strict TDD Red-Green workflow
---

# Implement Skill (TDD Red-Green)

When implementing any feature or bugfix, follow this strict TDD Red-Green workflow:

## 🔴 Red: Write Failing Test First

Before writing any implementation code:

1. Create or identify the test file
2. Write a test that describes the expected behavior
3. **Run the test and confirm it FAILS** (this is critical - the test must be red)

```bash
pnpm test -- --filter <package> <test-file>
```

The test failure confirms:
- The behavior is not yet implemented
- The test is actually testing something
- You have a clear target for implementation

## 🟢 Green: Write Minimum Implementation

Write only enough code to make the failing test pass:

- No extra features
- No premature optimization
- No "nice to have" additions
- Just enough to turn the test green

Run the test again:

```bash
pnpm test -- --filter <package> <test-file>
```

**Confirm the test PASSES** (the test is now green).

## 🔄 Refactor (If Needed)

Only after the test passes:

- Clean up code
- Improve naming
- Remove duplication
- Improve structure

Run tests again after refactoring to ensure nothing broke.

## ✅ Verify Full Suite

Before considering implementation complete:

```bash
pnpm typecheck
pnpm test
```

## 🚫 Constraints

- **NEVER** write implementation before test
- **NEVER** skip the failing test step (red phase)
- **NEVER** add untested features
- **NEVER** write more implementation than needed to pass the test
- Each test should verify one behavior

## 📋 TDD Cycle Summary

```
Red → Green → Refactor → Repeat
```

1. **Red**: Test fails (behavior not implemented)
2. **Green**: Test passes (minimum implementation)
3. **Refactor**: Clean up (tests still pass)
4. **Repeat**: Next behavior
