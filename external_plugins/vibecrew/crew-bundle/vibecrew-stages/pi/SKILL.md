---
name: vibecrew-stages
description: >-
  Resolve a VibeCrew card's `## Pipeline` block when it is written in REFERENCE
  form — a numbered list of stage NAMES plus an `id:` each, instead of the full
  stage prompts inlined. Use this skill WHENEVER you are running a card whose
  pipeline block lists stages as ``1. Create spec — `id: spec` `` and you need
  the actual instructions for a stage, or when you see the line "Stage names
  only" in a card description. It prints each ticked stage's full prompt, in the
  card's own order, rendered exactly as an inlined block would have carried it.
  Do NOT use it to compose a pipeline onto a card (that is `product-manager` /
  `POST /api/pipelines/:name/compose`), to change a pipeline's stages, or on a
  card whose block already spells its stages out — that text is already in front
  of you.
---

# Reading a reference-form `## Pipeline` block

A card's pipeline block comes in two grammars. Both are current; both parse.

**Full text** (every card filed before A4, and any hand-written block) inlines
the whole prompt:

```
1. Write a technical spec for this card and save it to `SPEC.md` at the repo root before implementing. `SPEC.md` is pipeline paperwork, not a deliverable: never commit it — add it to …
```

**Reference** (the default since A4) carries the stage's name and its id:

```
1. Create spec — `id: spec`
2. Create plan — `id: plan`
3. Merge to base — `id: merge`
```

If the block you are looking at is full text, **you already have the
instructions** — read them and go. This skill is for the reference form.

## Why the text is not on the card

The block is fixed overhead: it is re-read on every stage, every hand-off and
every resume for the life of the card. Inlined, a `Basic` spec+plan+merge card
carried 2,290 bytes and an `Async` card 8,590. In reference form the same cards
carry 1,073 and 1,234 — the stage text is fetched **once, by the agent that
needs it**, instead of riding along in every prompt.

Nothing was reworded. The prompts you get back are byte-identical to what the
inlined block would have said, because they come out of the same renderer.

## Getting the text

```sh
python3 "${VIBECREW_API:-${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py}" stages $VIBECREW_CARD_ID --text
```

That prints every **ticked** stage, numbered the way the card numbers them, with
its full prompt and its resolved binding. One stage at a time:

```sh
python3 "${VIBECREW_API:-${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py}" stages $VIBECREW_CARD_ID --stage merge
```

Drop `--text` for JSON (`id`, `label`, `prompt`, `agent`, `model`,
`cross_agent`) when you want to read a field rather than the prose.

**The numbering matches the card.** `stages` returns the ticked stages in the
block's own order — so stage 3 here is the stage the card calls 3, and the
`VK-PIPELINE-STAGE: 3` you emit refers to the same thing. Run it **once**, up
front, and keep the result; it does not change while the card runs.

## How it resolves (and why it cannot drift)

`stages` takes the pipeline name and the executor/model/per-stage bindings from
the card's `extension_metadata.pipeline` — what the card was **filed** with —
and hands them to `POST /api/pipelines/:name/compose`, which runs VibeCrew's
`PipelineComposer` on the Swift side. There is exactly one renderer and this is
a client of it, so placeholders (`{{DELEGATE}}`, `{{agent_name}}`,
`{{model_name}}`) come back already resolved for the agent each stage is bound
to, exactly as at filing time.

**Which stages** comes from the block, not the metadata. The metadata records
what the card was filed with; the block is what you were told to execute and
what your stage numbers mean. They normally agree — the composer writes both —
but a hand-edited block makes them disagree, and then the block wins. If they
do disagree, `stages` says so on stderr with both lists; read that warning, do
not ignore it.

## When the first door is shut

The block names the fallbacks, so you are never stuck:

1. **`vibecrew_api.py stages`** — above. Needs a reachable backend
   (`$VIBECREW_URL`).
2. **The pipeline TOML.** The block names the pipeline; read each stage's
   `prompt` under its `id` from `GET $VIBECREW_URL/api/pipelines/<name>` (the
   `toml` field), or off disk at `~/.vibecrew/pipelines/<name>.toml`, or from
   the plugin's bundled `pipelines/`. This text is **unrendered** — a
   `{{DELEGATE}}` you meet here means "delegate to the stage's subagent, or do
   it yourself if you cannot"; `{{agent_name}}` / `{{model_name}}` mean the
   stage's bound agent and model, which the stage's name in the block already
   tells you (`Plan review via Codex · GPT-5.6`).
3. **Neither available?** Say so plainly and run the stage from its name and the
   standing pipeline guidance in your prompt. `Create spec`, `Create plan`,
   `Review plan`, `Wait for approval`, `Merge to base`, `Open pull request` and
   `Update documentation` all mean what they say. Do not silently skip a stage
   because you could not read its text — name the stage and what you did.

## Rules

- **Do not reorder, add or skip stages.** The block's order is the contract; the
  stage text says what each one does, never which ones apply.
- **Emit the marker.** `VK-PIPELINE-STAGE: N` as you begin stage N, exactly as
  the block instructs. The host's cost gates read those markers.
- **The card's block wins on ordering; the fetched prompt wins on content.** If
  they disagree about anything else, the prompt is the stage's real instruction.
- This skill **reads**. It never edits a pipeline, a card, or the board.
