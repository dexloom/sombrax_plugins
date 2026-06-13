---
name: answer-questions
description: >-
  The method for answering a coding agent's pending QUESTION prompt (an
  AskUserQuestion / plan-mode questionnaire it raised through vibe-kanban) on the
  operator's behalf — gather the card/spec/plan/transcript context, pick the
  best-supported option for each question, and submit it via
  respond_to_approval(decision='answer'). Use this skill WHENEVER you need to
  resolve a stale question an agent is blocked on without a human in the loop —
  the orchestrator invokes it (or spawns the `decider` agent that wraps it) after
  its two-tick grace, and an operator can invoke it directly to clear a stuck
  questionnaire. This is for QUESTION prompts (decision='answer'), NOT
  tool-permission approvals (approve/deny) and NOT for authoring specs or plans.
---

# Answering an agent's question on the operator's behalf

A coding agent has raised a **question prompt** (it called `AskUserQuestion`, or a
plan-mode questionnaire) and is blocked waiting for an answer. Your job: choose the
answer the operator most likely would, grounded in the work itself, and submit it —
so the agent keeps moving instead of stalling on a human.

This is **selection under context**, not improvisation. Spend the effort to ground
the choice; a wrong answer here silently steers the implementation.

## What you're given

You need the `approval_id`, the `execution_process_id`, and the question payload:
one or more **questions**, each with its exact `question` text and a set of
**options** (each an `answer` label, sometimes with a description). You answer with
one entry per question — the exact `question` text plus the chosen `answer`
label(s) (a question may allow multiple).

The authoritative source is **`list_pending_approvals(execution_process_id)`**: it
returns each pending approval with its `approval_id`, `kind`, the full question +
options, and **`age_seconds`** (how long it has waited). Use it to confirm the
question is **still pending** before answering — never submit an answer to one
that's already resolved — and to read options you weren't handed. For *why* the
agent is asking, `get_execution(execution_id)` → `final_message` and (Claude Code
Headed with headed-local-control) the transcript at `claude_transcript_path`.

## Gather context before choosing (this is the "special effort")

Don't answer from the question text alone. Build the picture:

1. **The card** — `get_issue` for the title, description, and the `## Pipeline`
   block: what is this card actually trying to achieve, and what's in/out of scope.
2. **The spec** — `SPEC.md` at the workspace root if present (the `product` agent
   writes it there). The spec often already decides the question.
3. **The plan** — `IMPLEMENTATION_PLAN.md` at the workspace root if present (the
   `planner` agent writes it there). The current step and its `done-when` usually
   point straight at the right option.
4. **The code / the agent's state** — `Read`/`Grep`/`Glob` the worktree to confirm
   what the question is really about (a real file, a real choice), and
   `get_execution` `final_message` for *why* the agent is asking.

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

`respond_to_approval(approval_id, execution_process_id, decision="answer",
answers=[{ question: "<exact question text>", answer: "<chosen label>" }, …])` —
one entry per question, the `answer` matching an option label exactly (multiple
labels if the question allows it). Submitting is a **real, live action** that
unblocks the agent — it is not a dry run.

## Report

End with a short, scannable account, because this ran without the operator:

- Each question and the option you chose, with the **one-line reason** (which
  spec/plan/code signal drove it).
- Any choice you were **not confident** about, or any question that looked like a
  broken premise — called out so the operator can override in one pass.
- Confirm the answer was submitted (the `respond_to_approval` result).

Do not author specs or plans, write code, approve tool-permission prompts, or
start/stop agents here — this skill only answers question prompts.
