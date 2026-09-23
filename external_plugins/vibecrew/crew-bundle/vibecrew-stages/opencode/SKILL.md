---
name: vibecrew-stages
description: >-
  Resolves a VibeCrew card's `## Pipeline` block written in reference form (a
  numbered list of stage names, each with an `id:`, instead of the full stage
  prompts) and prints each ticked stage's full prompt in the card's own order,
  rendered exactly as an inlined block would carry it. Use when running a card
  whose block lists stages like ``1. Create spec — `id: spec` ``, or whose
  description contains the line "Stage names only", and you need a stage's
  actual instructions. Not for composing or changing a pipeline, or for a card
  whose block already spells its stages out.
tools: Read, Bash
---

# Reading a reference-form `## Pipeline` block

The user's (or operator's) explicit instructions take precedence over this skill's defaults.

A card's pipeline block comes in two grammars. Both are current and both parse.

Full text (every card filed before A4, and any hand-written block) inlines the
whole prompt:

```
1. Write a technical spec for this card and save it to `SPEC.md` at the repo root before implementing. `SPEC.md` is pipeline paperwork, not a deliverable: never commit it — add it to …
```

Reference form (the default since A4) carries the stage's name and its id:

```
1. Create spec — `id: spec`
2. Create plan — `id: plan`
3. Merge to base — `id: merge`
```

If your block is full text, you already have the instructions; read them and
go. This skill is for the reference form.

The stage text is left off the card because the block is re-read on every
stage, hand-off and resume. Inlined, a `Basic` spec+plan+merge card carried
2,290 bytes and an `Async` card 8,590; in reference form they carry 1,073 and
1,234. The prompts you fetch are byte-identical to what an inlined block would
say, because they come from the same renderer.

## Getting the text

Fetch every ticked stage once, before stage 1, and keep the result for the
rest of the run; it does not change while the card runs:

```sh
python3 "${VIBECREW_API:-${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py}" stages $VIBECREW_CARD_ID --text
```

That prints every ticked stage, numbered as the card numbers them, with its
full prompt and resolved binding. For one stage:

```sh
python3 "${VIBECREW_API:-${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py}" stages $VIBECREW_CARD_ID --stage merge
```

Leave out `--text` for JSON (`id`, `label`, `prompt`, `agent`, `model`,
`cross_agent`) when you want a field rather than the prose.

The numbering matches the card: stage 3 here is the stage the card calls 3, and
the `VK-PIPELINE-STAGE: 3` you emit refers to the same stage.

## How it resolves

`stages` takes the pipeline name and the executor, model and per-stage
bindings from the card's `extension_metadata.pipeline` (what the card was
filed with) and passes them to `POST /api/pipelines/:name/compose`, which runs
VibeCrew's `PipelineComposer`. There is one renderer and this is a client of
it, so `{{DELEGATE}}`, `{{agent_name}}` and `{{model_name}}` come back resolved
for the agent each stage is bound to, as at filing time.

Which stages to run comes from the block, not the metadata. The metadata
records what the card was filed with; the block is what you were told to
execute and what your stage numbers mean. The composer writes both, so they
normally agree. After a hand edit they can disagree, and then the block wins:
`stages` prints a warning with both lists on stderr, and you should read it.

## When `stages` is unavailable

1. `vibecrew_api.py stages` (above) needs a reachable backend (`$VIBECREW_URL`).
2. Otherwise read each stage's `prompt` under its `id` from the pipeline TOML
   the block names: `GET $VIBECREW_URL/api/pipelines/<name>` (the `toml`
   field), `~/.vibecrew/pipelines/<name>.toml` on disk, or the plugin's bundled
   `pipelines/`. This text is unrendered. A `{{DELEGATE}}` there means
   "delegate to the stage's subagent, or do it yourself if you cannot";
   `{{agent_name}}` and `{{model_name}}` mean the stage's bound agent and model,
   which the stage's name in the block already gives
   (`Plan review via Codex · GPT-5.6`).
3. If neither is available, say so and run each stage from its name and the
   standing pipeline guidance in your prompt. `Create spec`, `Create plan`,
   `Review plan`, `Wait for approval`, `Merge to base`, `Open pull request` and
   `Update documentation` mean what they say. Run every listed stage even when
   you could not read its text, and report which stage that was and what you
   did.

## Rules

- Run the stages in the block's order; don't add, skip or reorder any. The
  stage text says what each stage does, never which stages apply.
- Emit `VK-PIPELINE-STAGE: N` as you begin each stage N, as the block
  instructs. The host's cost gates read those markers.
- The block wins on ordering; the fetched prompt wins on content.
- This skill only reads. It never edits a pipeline, a card or the board.
