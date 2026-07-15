# Ship Orchestrator

Agent: Multi-Agent Software Delivery Pipeline
version: 1.0.0
description: |
  Orchestrates the 4-agent pipeline: Planner → Coder → Tester → Reviewer.
  Triggered by the /ship slash command defined in CLAUDE.md.
  Each agent runs only if the previous step completed successfully.
created: (set at runtime)

---

## Pipeline Flow

Planner → Coder → Tester → Reviewer

---

## Execution Steps

### Step 1: Run Planner (claude-sonnet-4-6)

- Load `.pipeline/planner.md` as the agent configuration
- Pass the task description from the /ship argument
- Expected output: `.pipeline/plan.md`
- Gate: plan.md must exist and must not contain `status: BLOCKED`
- On failure: write `.pipeline/pipeline-error.md` with agent=PLANNER and halt

### Step 2: Run Coder (claude-sonnet-4-6)

- Load `.pipeline/code.md` as the agent configuration
- Pass `.pipeline/plan.md` as context
- Expected output: `.pipeline/changes.md` plus modified source files
- Gate: changes.md must exist
- On failure: write `.pipeline/pipeline-error.md` with agent=CODER and halt

### Step 3: Run Tester (claude-haiku-4-5-20251001)

- Load `.pipeline/tester.md` as the agent configuration
- Pass `.pipeline/changes.md` and `.pipeline/plan.md` as context
- Expected output: `.pipeline/test-results.md`
- Gate: test-results.md must exist; summary line must start with PASS
- On failure (FAIL verdict): write `.pipeline/pipeline-error.md` with agent=TESTER and halt

### Step 4: Run Reviewer (claude-opus-4-8)

- Load `.pipeline/reviewer.md` as the agent configuration
- Pass all three previous artefacts as context; instruct to run git diff
- Expected output: `.pipeline/review.md`
- Gate: review.md must exist; verdict must be SHIP or NEEDS WORK (BLOCK = halt)
- On BLOCK: write `.pipeline/pipeline-error.md` with agent=REVIEWER and halt

---

## Success Criteria

- [ ] All four steps completed without error
- [ ] `.pipeline/plan.md` exists
- [ ] `.pipeline/changes.md` exists
- [ ] `.pipeline/test-results.md` exists with PASS verdict
- [ ] `.pipeline/review.md` exists with SHIP or NEEDS WORK verdict

---

## Failure Handling

On any failure:
1. Stop immediately — do not proceed to subsequent steps
2. Write `.pipeline/pipeline-error.md` with:
   - `agent:` which agent failed
   - `step:` which step number
   - `reason:` a plain-language explanation
   - `artefacts:` list of files produced before the failure
3. Surface the error clearly to the developer
4. Do not attempt to auto-recover or retry without developer instruction

---

## pipeline-error.md format

```
## Pipeline Error

agent: PLANNER | CODER | TESTER | REVIEWER
step: 1 | 2 | 3 | 4
reason: <plain-language explanation of what went wrong>

## Artefacts produced before failure
<list of .pipeline/*.md files that were successfully written>

## Recommended action
<one actionable sentence for the developer>
```

---

## Notes

- Artefact files from previous runs are overwritten on each /ship invocation
- The pipeline is not resumable mid-run; re-run /ship after fixing the reported issue
- Review verdicts of NEEDS WORK are not failures; the pipeline completes and surfaces the fix list
- All model assignments are in the individual agent .md files; update them there to change models
