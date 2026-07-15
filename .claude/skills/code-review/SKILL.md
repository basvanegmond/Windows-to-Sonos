---
name: code-review
description: Perform a thorough code review. Use when asked to review, check, or audit code.
user-invocable: true
---

Perform a structured code review on the specified file(s) or diff.

## Review dimensions

### Correctness
- Does the code do what it's supposed to?
- Are edge cases handled?
- Are error conditions properly managed?

### Security
- No hardcoded secrets or credentials
- Input validation on all user-supplied data
- Auth checks where required

### Performance
- No N+1 queries
- No unnecessary re-renders
- Heavy operations are async or cached

### Maintainability
- Code is self-documenting (clear names, small functions)
- No duplicated logic
- Tests cover the changed behaviour

## Output format
```
CRITICAL:   [issue] — [file:line] — [suggested fix]
WARNING:    [issue] — [file:line] — [suggested fix]
SUGGESTION: [improvement] — [file:line]
```
