---
name: fix-issue
description: Investigate and fix a GitHub issue end-to-end
---

Fix GitHub issue number $ARGUMENTS.

1. `gh issue view $ARGUMENTS` — read requirements fully
2. Explore the codebase to find relevant files
3. Write a fix plan before touching any code
4. Implement the fix in small, reviewable steps
5. Write or update tests to cover the fix
6. Check the fix with `python -m py_compile *.py` and `node --check static/app.js`, then start the app (README, "Try it in two minutes") and exercise the change
7. Commit with message: `fix: [issue title] (#$ARGUMENTS)`
8. `gh pr create` — link the PR to the issue
