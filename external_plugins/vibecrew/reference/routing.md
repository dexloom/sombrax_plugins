# Pipeline routing — family first, classify at intake, bind the coder after the plan

**Status:** designed 2026-08-05 from the measured board telemetry (below).
**Rubric source of truth:** `skills/classify-task/SKILL.md` — this document is
the design record (evidence, architecture, savings model, follow-ups); the
skill is what agents execute. When they disagree, fix the skill, then this doc.

## 1. The two families — the axiom everything else follows

VibeCrew's bundled pipelines split by executor, and the split is absolute:

- **OpenCode** (`OPENCODE_HEADED`): Async OpenCode GLM / GLM-MiniMax /
  Kimi-MiniMax — build models are **MiniMax / GLM / Kimi only**.
- **Claude Code** (`CLAUDE_CODE_HEADED`): Async Sonnet / Opus / Fable — build
  models are **Sonnet / Opus / Fable only**.
- **Basic** is family-neutral (no `agent`, no `[models]`).
- **Codex is the shared reviewer** — `plan-review-codex` / `code-review` bind
  to `CODEX` in both families; Codex is never a build model.

**Never mix.** No stage, pin, or advice may name a model from the other
family. When the operator names no pipeline, the **executor picks the
family** (operator-named executor/model → config `executor_profile` → Claude
Code), and the tier picks the pipeline **within** it.

## 2. The telemetry, with receipts

Sources: `~/Documents/ObsidianKB/projects/vibecrew/telemetry/Pipeline
Telemetry — VibeCrew Board 2026-08.md` (pass 2, OpenCode-era board, n=13
done) and `…/Pipeline Telemetry — SombraX Board 2026-08.md` (pass 1,
Claude-era, n=65 done); raw JSONs alongside. Collector:
`skills/vibecrew-telemetry` (`vc_stats.py`).

- **Basic is the confirmed light lane:** a light card shipped for **~191K
  fresh tokens** (VIBE-3: 153 LOC).
- **Full ceremony is cheap on GLM:** Async OpenCode GLM medians **507K
  fresh / 879 LOC-per-1M-fresh** over 8 cards — the old "ceremony tax" that
  justified skipping spec/plan on mid-size cards was a model-price artifact.
  Medium therefore routes to full ceremony, not to a stripped pipeline.
- **Codex review is its own budget, and the largest one:** 27.5M tokens
  across 8 reviewed cards; plan-review median **2.05M/card** — ~4× a whole
  GLM main loop. On all-in accounting GLM's 879 drops to 101 LOC/1M.
- **Plan size ≥ ~40 KB is the strongest blowup predictor:** small-plan cards
  shipped 8-of-9; big-plan 1-of-4, absorbing 21.2M vs 6.3M review tokens.
  Measurable **after the plan, before any coder token** — hence the late
  binding (§4).
- **Review loops don't converge past two passes:** VIBE-6 paid 7.5M
  plan-review tokens for 0 LOC; VIBE-11 two diff passes, 2.1M, 0 LOC.
- **Main-loop babysitting of codex is real money:** VIBE-13 burned 18.3M
  cache-inclusive during plan-review alone.
- **Coder efficiency (fresh tokens per LOC):** GLM-5.2 **743–867** (best
  measured) · Opus-plan+Sonnet-coder 744 on the single best async card ·
  Opus coder ~1,666 · Sonnet coder on thin plans 5,155 · **MiniMax-M3
  5,855–10,851** (median 21 LOC/card; needed a follow-up debug card).
- **Uncalibrated arms:** Async Fable n=0 on both boards; Kimi n=0 pipeline
  completions. They stay explicit-ask-only until measured.
- **Plan quality, not coder model, is the first-order cost driver** — both
  reports converge on this; it is why spec/plan stay on strong models and the
  coder is the axis that flexes.

## 3. The model

```
        brief / roadmap item
                │
     product-manager / product agent
                │  drafts spec ── then classifies
                ▼
        ┌─ classify-task ─┐   Step 1: FAMILY (executor ladder; never mixed)
        │ family → tier   │   Step 2: tier — S D R N V, 0–2 each, forces
        └───────┬─────────┘
   trivial    light      medium     heavy
   Basic    AsyncSonnet  AsyncOpus  AsyncOpus+CR, pr     (Claude Code)
   Basic    AsyncGLM     AsyncGLM   AsyncGLM+CR, pr      (OpenCode)
                │
                ▼  card carries **Routing:** line + ## Pipeline block (merge ON)
        orchestrator: dependency gate (lanes) → dispatch lighter tiers first
                │
                ▼  runtime, after the plan stage exists:
        PLAN-FACTS → PLAN-GATE (skip codex plan review < 40 KB, 0 open
        decisions, unless Routing forces yes; cap 2 passes)
                 → CODER-MODEL (step up within family: sonnet→opus,
                   MiniMax→GLM; operator pin wins; never cross family)
                │
                ▼  VK-ESCALATE park when grounding contradicts the tier
```

Classification happens **at card creation** (all the signal in one place,
changing the route free); the **coder model and the plan-review decision bind
after the plan exists** — the app freezes `extension_metadata` at creation
with no later re-composition, so late binding lives in the stage prompts and
`prompts/pipeline.md`, not in metadata.

## 4. What shipped where (rollout table)

| Artifact | Change |
|---|---|
| `pipelines/*.toml` (**new**, deployed to `~/.vibecrew/pipelines/`) | override copies of all 7 bundled pipelines: `merge` default-ON everywhere; plan stage emits `PLAN-FACTS`; `plan-review-codex` gains the 40 KB gate + 2-pass cap; `code-subagent` gains the in-family CODER-MODEL check; `merge` gains the artifact gate; spec/plan paperwork never committed (`git rev-parse --git-path info/exclude`). Claude files renamed `async-claude-*` (display `name =` kept — the registry shadows bundled by name). Generator: `scripts/generate_pipeline_overrides.py` (asserts every edit fired, so upstream drift breaks generation, not silently). |
| `skills/classify-task/SKILL.md` | **new** — family ladder, rubric, per-family tier maps, toggles, Routing line |
| `skills/product-manager/SKILL.md` | classify step 5; pipeline routed-by-default, composed from the TOML (numbered stages); **Lanes** section |
| `agents/product.md` | classify-and-route bullet; worktree-truth fix for `SPEC.md` |
| `agents/planner.md` | Plan facts section; `VK-ESCALATE` envelope tripwire; worktree-truth fix |
| `agents/coder.md` | paperwork/named-path commit rule; `VK-ESCALATE` tripwire |
| `prompts/pipeline.md` | numbered-block + `VK-PIPELINE-STAGE` markers; worktree-root truth + exclude rule; Routing semantics + never-mix; PLAN-FACTS/PLAN-GATE/CODER-MODEL; review caps; artifact gate in merge protocol step 3; `VK-ESCALATE` stop condition |
| `prompts/plan.md` | worktree-truth fix + exclude rule |
| `agents/orchestrator.md`, `scripts/orchestrator.prompt.md` | dependency gate (lanes) in readiness; lighter-tiers-first dispatch + tier in report; escalation-park recognition |
| `scripts/vibecrew_api.py`, `skills/vibecrew/SKILL.md` | `card-relationships` / `card-relate` / `card-unrelate` (+ docs; direction blocker→blocked, outgoing-only reads) |
| `CLAUDE.md` | block grammar corrected (numbered + order-instruction + current model-pin literal); families + never-mix; routing/late-binding literals; `VK-ESCALATE` defined |

## 5. Lanes — how parallel work is encoded

A multi-card brief files as: one plain **epic** card (no pipeline, no
orchestrate — never dispatched) + sub-cards via `parent_card_id` + `blocking`
relationships chained **within** a lane (created on the blocker; direction
blocker → blocked). No edge between lanes IS the parallelism. The
orchestrator's gate reads edges from the blocker side (the REST read returns
outgoing rows only), holds blocked cards (`waiting on <id>`), and a blocker
going `done` frees its dependents the next tick — no stored state. The app
renders the same edges as the board's dependency forest.

## 6. Artifacts-on-main — why the gate exists

In VibeCrew the workspace root **is** the git worktree
(`WorkspaceService.create` stores the worktree path as `container_ref`), so
`SPEC.md` / `IMPLEMENTATION_PLAN.md` written "at the workspace root" sit
inside the repo — and they **have** landed on main (the vibecrew repo tracks
both, rewritten by feature commits). Three layers now prevent it: exclude-file
entry at write time, named-path staging (never `git add -A`), and the merge
protocol's artifact gate (`git diff --name-only "$OLD"..HEAD` must not list
paperwork). The old prompt text claiming the workspace root "sits outside
every repo so files there are never committed" was inherited from
vibe-kanban-indie's layout and was false here; it is corrected everywhere.

## 7. Follow-ups (file as cards on the VibeCrew board)

1. **Upstream the TOML changes** into
   `CrewKit/Sources/CrewPipeline/Resources/DefaultPipelines/` (+
   `BundledPipelineTests`) so fresh installs get merge-on + the gates without
   the plugin's overrides; until then the deployed `~/.vibecrew/pipelines/`
   copies are authoritative and shadow the bundled set by name.
2. **Rename the bundled Claude pipelines** to match the `async-claude-*`
   file convention (and, if wanted, display names "Async Claude …") — an
   app-side rename; the overrides keep the current `name =` values until
   then, because that is the shadowing key.
3. **`extension_metadata` over REST** (accept it in `CreateCardBody`) so
   plugin-filed cards get first-class pipeline labels in the UI instead of
   description-only blocks.
4. **Telemetry feedback loop:** after ~20 routed cards, compare Routing lines
   vs actuals (transcript size, escalations, review passes) per the
   calibration rules in pass-2 §7; recalibrate the 40 KB gate and the tier
   thresholds with numbers, and record rubric edits in `classify-task` with a
   dated one-liner.
5. **Reviewer bake-off** — codex is the only reviewer ever measured; the
   review budget is the largest cost center, so alternatives (or a cheaper
   codex profile) are the highest-leverage unexplored saving.
