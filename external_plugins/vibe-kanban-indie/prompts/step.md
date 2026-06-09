<!--
step.md — sent by the orchestrator to drive ONE plan step. Fill {{N}} and {{STEP}}
from IMPLEMENTATION_PLAN.md before sending. One step per turn; the agent stops and
waits so the orchestrator stays in control of progression.
-->
Implement **exactly this step** from `IMPLEMENTATION_PLAN.md` — nothing beyond it:

**Step {{N}}: {{STEP}}**

Rules:
- Touch only what this step needs; don't run ahead into later steps.
- Match the surrounding code — its patterns, naming, and idioms.
- Make the step's `done-when` check actually pass (run it).

When it's done, report concisely:
- **Changed:** the files you touched and what changed.
- **Verified:** how you confirmed the `done-when` check passes.
- **Heads-up:** anything that affects the next step (a surprise, a new risk, a
  decision you had to make).

Then **stop and wait** — the orchestrator decides whether to proceed to the next
step, run a review, or adjust. Do not continue to the next step on your own.
