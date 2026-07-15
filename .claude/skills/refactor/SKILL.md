---
name: refactor
description: Safely refactor code to improve quality without changing behaviour. Use when asked to refactor, clean up, or improve code.
user-invocable: true
---

Refactor the specified code safely.

## Before refactoring
1. Confirm existing tests pass: `npm test`
2. Note what the code does (write it down)
3. Identify the specific smell to fix

## Refactoring approach
- One change at a time — small, verifiable steps
- Run tests after each step
- Common refactors:
  - Extract function (functions over 50 lines)
  - Extract constant (magic numbers/strings)
  - Rename for clarity
  - Remove duplication (DRY)
  - Simplify conditionals

## After refactoring
- All original tests still pass
- No new `any` types introduced
- Code is shorter or clearer (or both)
- Document what changed and why in the commit message
