---
name: answer-questions
description: >-
  The method for answering a coding agent's pending QUESTION prompt (an
  AskUserQuestion / plan-mode questionnaire it raised) on the operator's behalf
  — gather the card/spec/plan/transcript context, pick the best-supported
  option for each question, and submit it via `vibecrew_api.py approval-respond
  --status answered`. Use this skill WHENEVER you need to resolve a stale
  question an agent is blocked on without a human in the loop. NOTE (honest
  caveat): headless VibeCrew runs are spawned with
  `--dangerously-skip-permissions`, so tool-permission approvals never arise,
  and question approvals do not exist yet either — nothing in the current
  server raises them. This method is wired so it works the day the deferred
  headless-approvals hook (Agent-ops 5/5) ships; until then it is INERT — there
  is nothing pending to answer. This is for QUESTION prompts
  (`--status answered`), NOT tool-permission approvals (`approved`/`denied`)
  and NOT for authoring specs or plans.
---

# Answering an agent's question on the operator's behalf

A coding agent has raised a **question prompt** and is blocked waiting for an
answer. Your job: choose the answer the operator most likely would, grounded in
the work itself, and submit it — so the agent keeps moving instead of stalling
on a human.

**Inert until Agent-ops 5/5 (say this plainly, up front, every time this skill
runs):** VibeCrew spawns every headless run with
`--dangerously-skip-permissions`, so **tool-permission** approvals never occur.
**Question** approvals (`AskUserQuestion` / plan-mode questionnaires) require a
hook that intercepts them before the process exits — that hook is Agent-ops
5/5, and it has **not shipped yet**. So `approvals-pending` will normally
return nothing today, and this skill has nothing to do. It is documented and
wired anyway so it works the moment that hook ships — don't claim it "doesn't
work"; say it is **currently inert because nothing raises the approval it
would answer.**

This is **selection under context**, not improvisation. Spend the effort to
ground the choice; a wrong answer here silently steers the implementation.

## What you're given

You need the `approval_id` and the `run_id` (`execution_process_id` in the
client's terms), and the question payload: one or more **questions**, each
with its exact `question` text and a set of **options** (each an `answer`
label, sometimes with a description). You answer with one entry per question —
the exact `question` text plus the chosen `answer` label(s) as a **list of
strings** (a question may allow multiple).

The authoritative source is:

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py approvals-pending [run_id]
```

With no arg it's the **global** sweep (`GET /api/approvals/pending`); with a
`run_id` it's that run's pending approvals (`GET
/api/approvals/pending/<run_id>`). Each item carries the `approval_id`, the run
id, the questions + options, and `age_seconds` if present. Use it to confirm
the question is **still pending** before answering — never submit an answer to
one that's already resolved — and to read options you weren't handed.

For *why* the agent is asking:
```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py run <run_id>
```
→ `final_message` carries the agent's reasoning up to the point it asked.

## Gather context before choosing (this is the "special effort")

Don't answer from the question text alone. Build the picture:

1. **The card** — `python3 …/vibecrew_api.py card $VIBECREW_CARD_ID` (or the id
   you were given) for the title, description, and the `## Pipeline` block:
   what is this card actually trying to achieve, and what's in/out of scope.
2. **The spec** — `SPEC.md` at the workspace root if present (the `product`
   agent writes it there). The spec often already decides the question.
3. **The plan** — `IMPLEMENTATION_PLAN.md` at the workspace root if present
   (the `planner` agent writes it there). The current step and its
   `done-when` usually point straight at the right option.
4. **The code / the agent's state** — `Read`/`Grep`/`Glob` the worktree to
   confirm what the question is really about (a real file, a real choice),
   and `run <run_id>` → `final_message` for *why* the agent is asking.

## How to choose

For each question, pick the option that is **best supported**, in this order:

1. **Determined by spec/plan** — if the spec or plan already implies an answer,
   pick that option. This is the strongest signal; follow it.
2. **Consistent with the codebase** — match the surrounding patterns, naming, and
   prior decisions in the repo; pick the option a careful contributor would.
3. **Lowest-regret / most reversible** — when options are otherwise close, prefer
   the one that's conventional, smaller in blast radius, and easy to undo. Avoid
   the option that bakes in an irreversible or expensive choice unless the
   spec/plan clearly calls for it.
4. **Keep scope honest** — don't pick an option that expands the card beyond its
   stated scope; prefer the answer that delivers what the card asked, nothing more.

You answer **every** question put to you — the point is to unblock, not to defer.
But within a question, when one option authorizes something destructive,
irreversible, or clearly outside the plan and a safer option exists, choose the
**safer option** (or, for a free-text/"other" question, answer with the
conservative instruction). The gate is *which* option you pick, not *whether* you
answer.

A genuinely unanswerable question — one where every option is wrong, or the
question reveals the plan itself is broken — is a real signal: pick the least-bad
option to keep moving **and** flag it loudly in your report so the operator can
correct course, rather than silently guessing on a broken premise.

## Submit the answer

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py approval-respond <approval_id> \
  --execution-process-id <run_id> --status answered \
  --answers-json '[{"question":"<exact question text>","answer":["<chosen label>"]}]'
```

One entry per question in the JSON array; `answer` is a **list of strings**
(multiple labels if the question allows it). `--execution-process-id` is
**required** — the route's body decodes it as non-optional; the `approval_id`
path segment alone is not enough. Submitting is a **real, live action** that
unblocks the agent — it is not a dry run (once the hook that raises these
approvals exists).

## Report

End with a short, scannable account, because this ran without the operator:

- Each question and the option you chose, with the **one-line reason** (which
  spec/plan/code signal drove it).
- Any choice you were **not confident** about, or any question that looked like a
  broken premise — called out so the operator can override in one pass.
- Confirm the answer was submitted (the client's exit code / printed data).
- If `approvals-pending` returned nothing, say so plainly: **"no pending
  question approvals — inert until Agent-ops 5/5"** rather than silently doing
  nothing.

Do not author specs or plans, write code, approve tool-permission prompts, or
start/stop runs here — this skill only answers question prompts.
