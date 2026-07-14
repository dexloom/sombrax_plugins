---
name: compose-pipeline
description: >-
  Compose the byte-exact `## Pipeline` block that vibe-kanban's own New Issue
  dialog would have produced, for a card that should run itself. Discovers the
  real pipeline files (`~/.vibe-kanban/pipelines/*.toml`), selects the stages
  (defaults plus the user's adds/drops, with the `orchestrate` auto-drive
  opt-in only on an explicit ask), renders the block character-for-character,
  and hands it back to its caller together with the report facts — the caller
  places it on the card. Use this skill WHENEVER a pipeline has to go onto a
  card: "attach a pipeline", "compose the pipeline block",
  "add pipeline stages to a card", "execute Async Fable",
  "run it through Async Sonnet", "use the basic pipeline", "pin it to Codex".
  It is the SINGLE SOURCE OF TRUTH for the block's format: the web UI, the
  orchestrator, the execution agent, and the server all parse these exact
  generated lines back out of the card description, so a paraphrase inside the
  block silently breaks stage tracking. It does NOT write the spec, scope the
  work, or create/update the card — turning a rough brief into a dev-ready
  card is the `product-manager` skill, which calls this one for the pipeline
  part.
---

# compose-pipeline — the byte-exact `## Pipeline` block, composed once

## What this skill is for

A card that should "run itself" carries a `## Pipeline` block in its description
that is byte-for-byte what the vibe-kanban web UI's New Issue dialog would have
produced for the same selection. This skill composes that block. It mirrors
`packages/web-core/src/shared/lib/pipeline/cardPipeline.ts` in the vibe-kanban
repo: the orchestrator, the execution agent, and the server all parse these exact
generated lines back out of the card description — to know which stages are
still enabled, to seed the edit dialog, and to track live "stage N of M"
progress — so a paraphrase anywhere inside the block silently breaks that
round-trip.

Treat the format below as fixed, not as a style to approximate. The prose in
this header may be re-worded freely (nothing here is parsed) — the *literals* in
the body that follows may not.

## The contract — you compose, the caller persists

**Inputs from the caller:**

- the user's request phrasing (verbatim if available) — it is the evidence for
  whether execution/auto-drive was asked for, i.e. the `orchestrate` gate, and
  whether an executor was named;
- the pipeline name(s) (one, several, or none);
- stage add/drop overrides ("with merge", "skip the codex review");
- an executor pin, if one was named;
- **optionally** the card's current description, when the card already exists.

**What you hand back:** the composed block text, delimiters inclusive, ready to
place; plus the report facts (the checklist in the final section).

**You never call `create_issue` / `update_issue`.** The caller persists. Both
placement paths, stated as rules:

1. *New card* (`product-manager`): the block is appended to the description the
   caller is about to create — `<spec text>` + one blank line + the block, at the
   very end.
2. *Existing card* (e.g. an intake agent): `get_issue` → **strip any existing
   block** between the delimiters → append the new one → `update_issue`.

**Exactly one block per card.** Never nest or duplicate the delimiters — they
are how the UI replaces the block idempotently on later edits.

## Discover the pipeline

Pipelines live as TOML files on disk, not behind the MCP — read them directly,
you never invent one:

- `Glob` for `~/.vibe-kanban/pipelines/*.toml`. `Glob` doesn't expand `~`, so
  resolve it to the real absolute home path first (e.g.
  `/Users/<you>/.vibe-kanban/pipelines/*.toml`) before calling the tool.
- `Read` every candidate file. Each one is a pipeline: a top-level `name`, an
  optional `description`, and an ordered list of `[[stage]]` tables. Each stage
  has `id`, `label`, `prompt`, `default_enabled` (bool, defaults to `false` if
  absent), and `heavy` (bool, defaults to `false` if absent).
- Match the pipeline the user named against each file's `name` field,
  case-insensitively, or against the file stem (`async-fable.toml` →
  `async-fable`). "Async Fable", "async fable", and "async-fable" should all
  resolve to the same file.
- If nothing matches, don't guess and don't invent stages. List the real
  pipeline names you found on disk and ask which one via `AskUserQuestion`.

## Select the stages

- **Default selection** is every stage with `default_enabled = true`, kept in
  the order the stages appear in the file.
- If the user names steps to add or drop ("with merge", "skip the codex
  review", "no orchestrate"), apply those as overrides against the stage
  `label`s and `id`s — add stages they named that weren't default-enabled, drop
  ones they named that were.
- The `orchestrate` stage is the one exception to "default = `default_enabled`":
  include it **only** when the user explicitly asked for execution or
  auto-drive — phrasing like "and execute", "run it", "let the orchestrator
  take it", "auto-drive this". Naming a pipeline alone ("use Async Sonnet") is
  not enough; "execute Async Sonnet" or "run it through Async Sonnet" is.
- Note which enabled stages have `heavy = true` so you can flag their cost in
  the final report — never silently include a heavy stage without calling it
  out.

## Compose the block — byte-exact format

Build the block below and hand it back to your caller — you compose it, the
caller places it on the card. Exactly one block per card — never nest or
duplicate the delimiters, since they're how the UI replaces the block
idempotently on later edits.

```
<!-- vk:pipeline:start -->
## Pipeline: <Name>

Execute these stages in the order listed. Do not add, skip, or reorder stages. As you begin each numbered stage below, output a single line exactly `VK-PIPELINE-STAGE: N` (N = the number of the stage you are starting) so pipeline progress can be tracked.

1. <stage 1 prompt, verbatim from the TOML>
2. <stage 2 prompt, verbatim>
<!-- vk:pipeline:end -->
```

Rules, all of them load-bearing:

- **The heading** is `## Pipeline: <name>`. If the user's request resolves to
  more than one pipeline combined, join the names with ` + ` (e.g.
  `## Pipeline: Async Sonnet + Basic`), in the order the user named them. For the
  **stage order**, do exactly what the app does (`canonicalStageOrder` in
  `cardPipeline.ts`): take **every** stage of **every** selected pipeline (not just
  the enabled ones), dedupe by stage `id`, and order them with a **stable
  topological sort** — each consecutive pair of stages within a pipeline file is an
  ordering constraint the merged list must respect, and ties are broken by first
  appearance across the pipelines in the order the user named them. (If the
  constraints are ever cyclic the app appends the leftovers in first-seen order
  rather than dropping them; well-formed pipeline files are acyclic, so that is a
  safety net, not a rule to design around.) Then filter that canonical order down to
  the stages you selected. For a **single** pipeline — the common case — this is
  exactly the file's own order.
- **The order-instruction line is a fixed string** — it's the paragraph right
  under the heading in the format above. Reproduce it character-for-character,
  never paraphrased, reworded, or reflowed; that one copy above is the source
  of truth, don't retype it from memory elsewhere.
- **Optional executor pin** — only when the user names an execution agent
  ("with Claude Code", "pin it to Codex"). Place it after the order-instruction
  line and a blank line, before the numbered list, as exactly:

  `- Run this card with the **<AGENT>** execution agent: pass ` `executor: "<AGENT>"` ` when starting the workspace.`

  `<AGENT>` is a `BaseCodingAgent` key such as `CLAUDE_CODE` or `CODEX`.
  Rendered for `CLAUDE_CODE`, this is exactly:

  - Run this card with the **CLAUDE_CODE** execution agent: pass `executor: "CLAUDE_CODE"` when starting the workspace.
- **Stage prompts go into the numbered list verbatim** — copy the full `prompt`
  string from the TOML exactly as written, no paraphrasing, no summarizing, no
  extra prose inside the delimiters. The list is 1-indexed, in the same order
  as the stage selection above.
- **Placement:** append at the very end of the card description as
  `<spec text>\n\n<block>`. Exactly one block per card.

## Golden example

A card asking for "create a card and execute Async Fable" — the pipeline's
default stages plus explicit execution, so `orchestrate` is included:

```
<!-- vk:pipeline:start -->
## Pipeline: Async Fable

Execute these stages in the order listed. Do not add, skip, or reorder stages. As you begin each numbered stage below, output a single line exactly `VK-PIPELINE-STAGE: N` (N = the number of the stage you are starting) so pipeline progress can be tracked.

1. Have the orchestrator agent pick this card up and drive it to done autonomously, running the card's pipeline stages in order — regardless of which board column the card is in (it may be started even from Todo).
2. <prompt of stage "spec" ("Spec via Fable subagent"), verbatim from async-fable.toml>
3. <prompt of stage "plan" ("Plan via Fable subagent"), verbatim>
4. <prompt of stage "plan-review-codex" ("Codex plan review"), verbatim>
5. <prompt of stage "code-subagent" ("Code via Opus subagent"), verbatim>
6. <prompt of stage "code-review" ("Review via Codex"), verbatim>
<!-- vk:pipeline:end -->
```

Stage 1 is reproduced in full above because it's short and stable across
pipelines; stages 2–6 are shown as placeholders only so this doc doesn't
duplicate the entire TOML file. In real output there are no placeholders —
every numbered line is the stage's full `prompt` string copied
character-for-character out of the file you read.

If the user had instead said "use the Async Fable pipeline" (no mention of
executing it), the block would be identical except stage 1 (`orchestrate`)
would be dropped and the rest renumbered 1–5.

## Report what you attached

- Name the pipeline you attached (or the combined names, if merged).
- List the stages you enabled, flagging any with `heavy = true`.
- State whether `orchestrate` was included, and why (explicit ask vs. not
  requested).
- State the executor pin, if any, or note that none was set.
