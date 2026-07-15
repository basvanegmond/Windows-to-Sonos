---
name: pr-review
description: Full code review on current branch vs main before raising a PR
---

Review all changes on the current branch before raising a PR.

1. `git diff main...HEAD` — see all changes
2. Invoke code-reviewer agent on each changed file
3. Check for missing tests
4. Verify CLAUDE.md conventions are followed
5. Produce a structured PR description:
   - What changed and why
   - Testing done
   - Screenshots (if UI changes)
   - Checklist: lint ✓, tests ✓, build ✓
