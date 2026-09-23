---
name: answer-questions
description: >-
  Answers a coding agent's pending question prompt (an AskUserQuestion or
  plan-mode questionnaire) on the operator's behalf: gathers the card, spec,
  plan and run context, picks the best-supported option for each question, and
  submits it with `vibecrew_api.py approval-respond --status answered`. Use when
  an agent is blocked on a stale question and no human is in the loop, for
  example "answer that questionnaire", "decide this for me", "unblock the
  agent's question". Not for tool-permission approvals (`approved` / `denied`)
  or for writing specs or plans.
---

# Answering an agent's question on the operator's behalf

The user's (or operator's) explicit instructions take precedence over this skill's defaults.

A coding agent raised a question prompt (it called `AskUserQuestion`, or a
plan-mode questionnaire) and is blocked waiting for an answer. Choose the
answer the operator would most likely give, grounded in the work, and submit
it so the agent keeps moving. This is selection under context, not
improvisation: a wrong answer here steers the implementation without anyone
noticing.

## When there is nothing to answer

Which runs raise question approvals depends on the executor:

- OpenCode runs do. Their `question.asked` events become real `approvals` rows,
  and answering here unblocks the agent.
- Claude headless runs don't. VibeCrew spawns them with
  `--dangerously-skip-permissions`, so tool-permission approvals never occur,
  and question approvals need a hook that intercepts them before the process
  exits (Agent-ops 5/5), which has not shipped.

So an empty `approvals-pending` is normal, especially on a Claude fleet. Say
so plainly in your report ("no pending question approvals; Claude runs stay
inert until Agent-ops 5/5") rather than doing nothing silently, and don't
describe the skill as broken.

## What you're given

You need the `approval_id`, the `run_id` (`execution_process_id` in the
client), and the question payload: one or more questions, each with its exact
`question` text and a set of options (each an `answer` label, sometimes with a
description). You answer with one entry per question: the exact `question`
text plus the chosen `answer` label(s) as a list of strings (some questions
allow several).

The authoritative source:

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py approvals-pending [run_id]
```

With no argument it is the global sweep (`GET /api/approvals/pending`); with a
`run_id` it lists that run's pending approvals
(`GET /api/approvals/pending/<run_id>`). Each item carries the `approval_id`,
the run id, the questions and options, and `age_seconds` when present. Use it
to confirm the question is still pending before answering, and to read options
you weren't handed.

## Gather context before choosing

Build the picture from these sources, not from the question text alone:

1. The card: `python3 …/vibecrew_api.py card $VIBECREW_CARD_ID` (or the id you
   were given) for the title, description and `## Pipeline` block: what the
   card is trying to achieve and what is in or out of scope.
2. The spec: `SPEC.md` at the workspace root, if present. It often already
   decides the question.
3. The plan: `IMPLEMENTATION_PLAN.md` at the workspace root, if present. The
   current step and its `done-when` usually point at the right option.
4. The code and the agent's state: read and grep the worktree to confirm what
   the question is really about, and `python3 …/vibecrew_api.py run <run_id>`
   → `final_message` for why the agent is asking.

## How to choose

For each question, pick the best-supported option, in this order of strength:

1. The spec or plan implies an answer: pick it.
2. The codebase's patterns, naming and prior decisions favor one: pick what a
   careful contributor would.
3. Otherwise prefer the lowest-regret option: conventional, smaller blast
   radius, easy to undo. Choose an irreversible or expensive option only when
   the spec or plan calls for it.
4. Stay within the card's stated scope; prefer the answer that delivers what
   the card asked and nothing more.

Answer every question put to you; the point is to unblock. When one option
authorizes something destructive, irreversible or outside the plan and a safer
option exists, choose the safer one (for a free-text or "other" question,
answer with the conservative instruction).

If every option is wrong, or the question shows the plan itself is broken, pick
the least-bad option to keep the agent moving and flag it prominently in your
report so the operator can correct course.

## Submit the answer

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py approval-respond <approval_id> \
  --execution-process-id <run_id> --status answered \
  --answers-json '[{"question":"<exact question text>","answer":["<chosen label>"]}]'
```

One array entry per question; `answer` is a list of strings.
`--execution-process-id` is required: the route decodes it as non-optional, and
the `approval_id` path segment alone is not enough. Submitting is a live action
that unblocks the agent.

## Report

This ran without the operator, so end with a short account they can scan:

- Each question, the option you chose, and a one-line reason naming the spec,
  plan or code signal behind it.
- Any choice you were unsure of, and any question that looked like a broken
  premise, so the operator can override in one pass.
- Confirmation that the answer was submitted (the client's exit code or
  printed data).
- If `approvals-pending` returned nothing, say so as described above.

This skill only answers question prompts. Specs, plans, code, tool-permission
approvals and starting or stopping runs belong elsewhere.
