#!/usr/bin/env python3
"""Apply the 2026-08-05 family-routing update to the live vibe-kanban pipelines.

Operates on ~/.vibe-kanban/pipelines/ (the authoritative copies until the app
bundles them — see reference/routing.md):

  1. Rename the Claude-family files async-{sonnet,opus,fable}.toml to
     async-claude-*.toml (display `name =` untouched; the seed manifest keys on
     the original filenames, which stay listed, so nothing re-seeds).
  2. merge default-ON + squash-authorization wording everywhere (async-opus
     already had both).
  3. Late binding: the plan stage reports `PLAN-FACTS:`; plan-review-codex
     gains the 40 KB PLAN-GATE + two-pass cap; code-subagent gains the
     in-family CODER-MODEL check (Claude family: sonnet steps up to opus).
  4. Writes the new async-opencode-glm.toml — the OpenCode family's workhorse:
     a SELF-DRIVE pipeline (an OpenCode session cannot spawn the plugin's
     Claude subagents), spec adopt fast path included.

Every replacement asserts it fired exactly once, so drifted prompts break the
run instead of silently half-applying. Idempotent: a second run finds the old
anchors gone and reports "already applied".

Usage: python3 update_pipelines_routing.py [--dir ~/.vibe-kanban/pipelines]
"""

import argparse
import pathlib
import sys

RENAMES = {
    "async-sonnet.toml": "async-claude-sonnet.toml",
    "async-opus.toml": "async-claude-opus.toml",
    "async-fable.toml": "async-claude-fable.toml",
}

MERGE_OFF = (
    '[[stage]]\nid = "merge"\nlabel = "Merge to base"\ndefault_enabled = false\n'
)
MERGE_ON = (
    '[[stage]]\nid = "merge"\nlabel = "Merge to base"\ndefault_enabled = true\n'
)

MERGE_PROMPT_OLD = (
    'prompt = "When the work is implemented and reviewed, merge this card\'s branch into the '
    'base branch."'
)
MERGE_PROMPT_NEW = (
    'prompt = "When the work is implemented and reviewed, squash-merge this card\'s branch '
    "into the base branch yourself — this stage being listed is your authorization, so do not "
    'wait for a go-ahead; gating, when wanted, is the Wait-for-approval stage\'s job."'
)

PLAN_TAIL_OLD = (
    "re-spawn the subagent with the concrete gaps rather than writing the plan in the main loop.\""
)
PLAN_TAIL_NEW = (
    "re-spawn the subagent with the concrete gaps rather than writing the plan in the main loop. "
    "When the plan is verified, measure it and report the single line "
    "`PLAN-FACTS: <size> KB, <n> steps, <n> files, <n> open decisions` — the byte size of "
    "`IMPLEMENTATION_PLAN.md`, its numbered steps, the distinct files its steps name, and the "
    "open items in its Risks / open questions section; the next two stages read this line.\""
)

REVIEW_HEAD_OLD = 'prompt = "Before any code is written, have Codex independently review'
REVIEW_HEAD_NEW = (
    'prompt = "GATE FIRST — read the plan stage\'s PLAN-FACTS line (measure '
    "`IMPLEMENTATION_PLAN.md` yourself if it is missing): if the plan is under 40 KB AND has 0 "
    "open decisions AND the card's **Routing:** line (when it carries one) does not force the "
    "review with plan-review: yes, SKIP this stage — report the single line "
    "`PLAN-GATE: plan-review skipped (<size> KB, <n> open decisions)` and move on; a small, "
    "closed plan does not repay an independent review, which routinely costs more than the plan "
    "itself. Otherwise report `PLAN-GATE: plan-review running (<size> KB, <n> open decisions)` "
    "and proceed: have Codex independently review"
)

REVIEW_CAP_OLD = "Iterate until Codex reports no significant findings."
REVIEW_CAP_NEW = (
    "Iterate until Codex reports no significant findings, capped at TWO review passes — findings "
    "still open after the second pass mean the plan (or the spec above it) is mis-scoped: revise "
    "the plan (re-run the planning stage) or escalate; never pay a third pass."
)

CODE_HEAD_OLD = 'prompt = "Do NOT write the implementation yourself.'
CODE_HEAD_NEW = (
    'prompt = "MODEL CHECK FIRST — pick the coder model WITHIN this pipeline\'s own family '
    "before delegating: if the plan blew its envelope (PLAN-FACTS at or above 40 KB, or open "
    "design decisions surfaced during planning), step the coder model up one tier inside the "
    "family — on a Claude Code pipeline sonnet steps up to opus; a coder already at its family "
    "ceiling stays put. NEVER cross families: OpenCode pipelines run MiniMax / GLM / Kimi models "
    "only, Claude Code pipelines run Sonnet / Opus / Fable models only — Codex appears on both, "
    "but only ever as the reviewer, never as a build model. An operator's card-level model pin "
    "always beats this advice. Report the single line "
    "`CODER-MODEL: <model> — <one-phrase reason>`. Then: Do NOT write the implementation yourself."
)

ORCHESTRATE_PROMPT = (
    "Have the orchestrator agent pick this card up and drive it to done autonomously, running "
    "the card's pipeline stages in order — regardless of which board column the card is in (it "
    "may be started even from Todo)."
)

CODE_REVIEW_PROMPT = (
    "After implementing, run an independent Codex review of the card's diff (the `codex-review` "
    "skill / Codex CLI), iterating until it reports no significant findings, capped at TWO "
    "passes — findings still open after the second pass are a scope problem, not a review "
    "problem: fix what is confirmed, report what remains, and move on. Address confirmed "
    "findings and re-verify before marking the card ready."
)

OPENCODE_GLM = f'''name = "Async OpenCode GLM"
description = "Self-drive Async flow for an OpenCode (GLM-5.2) execution agent: the main loop writes the spec, plan, and code itself — an OpenCode session cannot spawn the plugin's Claude subagents — and Codex reviews the plan (gated) and, optionally, the diff. Run this pipeline with an OpenCode execution agent on its GLM-5.2 profile. OpenCode pipelines use MiniMax / GLM / Kimi models only; never mix in Claude models (Codex is the shared reviewer for both families)."

[[stage]]
id = "orchestrate"
label = "Orchestrate (auto-drive)"
default_enabled = false
prompt = "{ORCHESTRATE_PROMPT}"

[[stage]]
id = "spec"
label = "Spec (self)"
default_enabled = true
prompt = "FIRST, check the card description: if it already contains the full spec — meaning `### Outcome`, `### Scope`, and `### Testing & acceptance criteria` EACH occur at the START of a line (prefix match), and NOT inside a fenced code block or a block quote; ALL THREE are required and if any one is missing take the OTHERWISE path — then write `SPEC.md` at the workspace root as exactly: the line `## Task: <the card's title, verbatim>`, then a blank line, then the card description verbatim, stripping the `## Pipeline` block anchored to STANDALONE `<!-- vk:pipeline:start -->` / `<!-- vk:pipeline:end -->` marker lines (delete everything between them including both markers; a marker mentioned inside a prose line is not a delimiter), collapsing the blank run the strip leaves, and sweeping out any stray executor-pin bullet left outside the block. Do not edit, re-author, or re-verify the copied text: adopt the card's decisions as settled, report \\"spec adopted from card description\\", and move on. OTHERWISE, write the technical spec YOURSELF to `SPEC.md` at the workspace root — ground it in the card description plus quick repo lookups; cover the outcome, scope, technical requirements, and testing & acceptance criteria; keep any decisions the card already made settled rather than re-opening them."

[[stage]]
id = "plan"
label = "Plan (self)"
default_enabled = true
prompt = "Turn `SPEC.md` into a step-by-step `IMPLEMENTATION_PLAN.md` at the workspace root YOURSELF, grounded in real repo files — Goal, Approach, ordered Steps each naming the real `files:` it touches with an observable `done-when:` check, Verification, and Risks / open questions. When the plan is verified, measure it and report the single line `PLAN-FACTS: <size> KB, <n> steps, <n> files, <n> open decisions` — the next two stages read this line."

[[stage]]
id = "plan-review-codex"
label = "Codex plan review"
default_enabled = true
prompt = "GATE FIRST — read the plan stage's PLAN-FACTS line (measure `IMPLEMENTATION_PLAN.md` yourself if it is missing): if the plan is under 40 KB AND has 0 open decisions AND the card's **Routing:** line (when it carries one) does not force the review with plan-review: yes, SKIP this stage — report the single line `PLAN-GATE: plan-review skipped (<size> KB, <n> open decisions)` and move on. Otherwise report `PLAN-GATE: plan-review running (<size> KB, <n> open decisions)` and have Codex independently review `IMPLEMENTATION_PLAN.md` (`codex exec --sandbox read-only` over the plan — do NOT review it yourself). {REVIEW_CAP_NEW} Resolve confirmed findings by revising the plan before any code is written. This is a read-only plan review: do not modify code here."

[[stage]]
id = "implement"
label = "Implement (self)"
default_enabled = true
prompt = "Implement the card YOURSELF, strictly from `SPEC.md` and `IMPLEMENTATION_PLAN.md`, step by step — run each step's `done-when:` check, commit as you go, and run the project's own checks before advancing. You are the coder on this pipeline: a single-model OpenCode session, so there is no coder subagent to spawn and no cross-family model to borrow. If the work outgrows the card's Routing tier (an unpriced design decision, scope far beyond the plan), commit safe work and escalate with the `VK-ESCALATE: <tier>-><proposed-tier> — <evidence>` first line instead of grinding through."

[[stage]]
id = "code-review"
label = "Review via Codex"
default_enabled = false
prompt = "{CODE_REVIEW_PROMPT}"

[[stage]]
id = "merge"
label = "Merge to base"
default_enabled = true
prompt = "When the work is implemented and reviewed, squash-merge this card's branch into the base branch yourself — this stage being listed is your authorization, so do not wait for a go-ahead; gating, when wanted, is the Wait-for-approval stage's job."

[[stage]]
id = "pr"
label = "Open pull request"
default_enabled = false
prompt = "When the work is implemented and reviewed, open a pull request for this card against the base branch."
'''


def apply_edits(text, edits, fname, applied):
    for old, new in edits:
        n = text.count(old)
        if n == 0 and new in text:
            continue  # already applied
        if n != 1:
            sys.exit(f"{fname}: expected exactly 1 occurrence of {old[:60]!r}…, found {n}")
        text = text.replace(old, new)
        applied.append(f"{fname}: {old[:40]!r}…")
    return text


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(pathlib.Path.home() / ".vibe-kanban" / "pipelines"),
                    type=pathlib.Path)
    args = ap.parse_args()
    d = args.dir
    applied = []

    for old_name, new_name in RENAMES.items():
        src, dst = d / old_name, d / new_name
        if src.exists() and not dst.exists():
            src.rename(dst)
            applied.append(f"renamed {old_name} -> {new_name}")

    claude_edits = [
        (PLAN_TAIL_OLD, PLAN_TAIL_NEW),
        (REVIEW_HEAD_OLD, REVIEW_HEAD_NEW),
        (REVIEW_CAP_OLD, REVIEW_CAP_NEW),
        (CODE_HEAD_OLD, CODE_HEAD_NEW),
    ]
    for fname in ("async-claude-sonnet.toml", "async-claude-opus.toml",
                  "async-claude-fable.toml"):
        p = d / fname
        text = p.read_text(encoding="utf-8")
        text = apply_edits(text, claude_edits, fname, applied)
        # merge: flip default + align wording (async-claude-opus already has both)
        if MERGE_OFF in text:
            text = text.replace(MERGE_OFF, MERGE_ON)
            applied.append(f"{fname}: merge default_enabled -> true")
        if MERGE_PROMPT_OLD in text:
            text = text.replace(MERGE_PROMPT_OLD, MERGE_PROMPT_NEW)
            applied.append(f"{fname}: merge prompt -> squash wording")
        p.write_text(text, encoding="utf-8")

    basic = d / "basic.toml"
    text = basic.read_text(encoding="utf-8")
    if MERGE_OFF in text:
        text = text.replace(MERGE_OFF, MERGE_ON)
        applied.append("basic.toml: merge default_enabled -> true")
    if MERGE_PROMPT_OLD in text:
        text = text.replace(MERGE_PROMPT_OLD, MERGE_PROMPT_NEW)
        applied.append("basic.toml: merge prompt -> squash wording")
    basic.write_text(text, encoding="utf-8")

    glm = d / "async-opencode-glm.toml"
    if not glm.exists() or glm.read_text(encoding="utf-8") != OPENCODE_GLM:
        glm.write_text(OPENCODE_GLM, encoding="utf-8")
        applied.append("wrote async-opencode-glm.toml")

    print("\n".join(applied) if applied else "already applied — nothing to do")


if __name__ == "__main__":
    main()
