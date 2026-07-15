# .pipeline/

This folder contains the 4-agent delivery pipeline for this project.

## How it works

Run `/ship <task>` in Claude Code. The orchestrator runs four agents in sequence.
Each agent writes its output here. You review the result and decide whether to merge.

```
/ship add rate limiting to the login endpoint
       │
       ▼
  ship.md (orchestrator)
       │
       ├── planner.md  →  plan.md           (Sonnet 4.6)
       ├── code.md     →  changes.md        (Sonnet 4.6)
       ├── tester.md   →  test-results.md   (Haiku 4.5)
       └── reviewer.md →  review.md         (Opus 4.8)
```

## Agent configs (committed, do not delete)

| File | Purpose |
|------|---------|
| `ship.md` | Orchestrator — runs the full pipeline |
| `planner.md` | Agent 1 — writes the implementation spec |
| `code.md` | Agent 2 — implements the spec |
| `tester.md` | Agent 3 — writes and runs tests |
| `reviewer.md` | Agent 4 — final quality gate |

## Artefacts (generated at runtime, overwritten each run)

| File | Written by |
|------|-----------|
| `plan.md` | Planner |
| `changes.md` | Coder |
| `test-results.md` | Tester |
| `review.md` | Reviewer |
| `pipeline-error.md` | Orchestrator (only on failure) |

Artefacts are committed alongside source code so pipeline history is preserved in git.

## Verdicts

The Reviewer issues one of three verdicts in `review.md`:

- **SHIP** — ready to merge
- **NEEDS WORK** — merge after fixing the listed items
- **BLOCK** — do not merge; see blocking issues in review.md

## Changing models

Edit the `model:` field in the relevant agent `.md` file.
Current assignments are in `CLAUDE.md` at project root.
