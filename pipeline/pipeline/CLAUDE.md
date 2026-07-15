# CLAUDE.md

This file configures Claude Code behaviour for this project.
It is read automatically at the start of every Claude Code session.

---

## Slash Commands

### /ship

**Purpose:** Run the full 4-agent delivery pipeline on a task.

**Usage:**
```
/ship <task description>
```

**Example:**
```
/ship add rate limiting to the POST /auth/login endpoint
```

**What happens:**
1. Planner reads the codebase and writes a spec to `.pipeline/plan.md`
2. Coder implements the spec and writes a summary to `.pipeline/changes.md`
3. Tester writes and runs tests, writes results to `.pipeline/test-results.md`
4. Reviewer reads all artefacts, runs git diff, and writes a verdict to `.pipeline/review.md`

The pipeline halts on any failure and writes `.pipeline/pipeline-error.md` with the reason.
You do the final review and merge. The pipeline does everything else.

**Orchestrator config:** `.pipeline/ship.md`

---

## Pipeline Agents

| Agent | Config file | Model | Role |
|-------|------------|-------|------|
| Planner | `.pipeline/planner.md` | claude-sonnet-4-6 | Spec writing |
| Coder | `.pipeline/code.md` | claude-sonnet-4-6 | Implementation |
| Tester | `.pipeline/tester.md` | claude-haiku-4-5-20251001 | Test writing and execution |
| Reviewer | `.pipeline/reviewer.md` | claude-opus-4-8 | Final quality gate |

To change a model assignment, edit the `model:` field in the relevant agent file.

---

## Pipeline Artefacts

All pipeline output lives in `.pipeline/`. These files are overwritten on each /ship run.

| File | Written by | Contents |
|------|-----------|----------|
| `.pipeline/plan.md` | Planner | Implementation spec |
| `.pipeline/changes.md` | Coder | Summary of what changed |
| `.pipeline/test-results.md` | Tester | Test results and coverage |
| `.pipeline/review.md` | Reviewer | Verdict and issues |
| `.pipeline/pipeline-error.md` | Orchestrator | Error details (if pipeline halted) |

---

## Pipeline Conventions

These rules apply to all agents in the pipeline. Each agent config file also states them,
but they are recorded here as project-level conventions.

1. **Role isolation is strict.** The Planner never writes code. The Coder never plans. The Tester never fixes bugs. The Reviewer never edits files.
2. **Each step gates the next.** A step does not run if the previous step failed or produced an incomplete artefact.
3. **Halt, do not guess.** If any agent encounters an ambiguity it cannot resolve, it documents it and halts. It does not silently improvise.
4. **Artefacts are the handoff.** Agents communicate exclusively through `.pipeline/*.md` files. No implicit state.
5. **You own the merge.** The pipeline produces a SHIP / NEEDS WORK / BLOCK verdict. The final merge decision is always yours.

---

## Requirement Traceability (optional but recommended)

For larger tasks, prefix acceptance criteria in plan.md with requirement IDs (RQ-01, RQ-02, etc.).
Reference these IDs in commit messages and test names. This keeps spec intent traceable
through implementation and into the test suite.

Example commit: `feat: implement rate limiting (RQ-03, RQ-04)`
Example test: `it('RQ-03: rejects after 5 failed attempts', ...)`

---

## Notes

- The `.pipeline/` folder is committed to version control alongside source code
- Artefact `.md` files from previous runs are overwritten; use git history to review prior runs
- To run only specific agents, invoke their config files directly rather than using /ship
