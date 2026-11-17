---
name: ship
description: Run the 4-agent delivery pipeline (plan, code, test, review) on a task
disable-model-invocation: true
---

Run the delivery pipeline on this task: $ARGUMENTS

Follow `.pipeline/ship.md` step by step. The pipeline halts on any failure and writes `.pipeline/pipeline-error.md` with the reason. The final merge decision stays with the user.
