# Pipeline routing — main agent first, classify at intake, bind the coder after the plan

**Status:** designed 2026-08-05 from the measured board telemetry (below).
**Rubric source of truth:** `skills/classify-task/SKILL.md` — this document is
the design record (evidence, architecture, savings model, follow-ups); the
skill is what agents execute. When they disagree, fix the skill, then this doc.

## 1. The pipeline types and per-step bindings

**Superseded 2026-09-07** by the unified-pipeline card: the twelve per-model
`Async …` pipelines are gone, and so is the invariant that forbade a card from
mixing agents. What replaced them:

VibeCrew bundles **three** pipeline types, none of which binds an executor:

| Type | Name | Delegation | Shipped `[agents]` |
|---|---|---|---|
| **Base** | `Basic` | none — no stage carries a role | none |
| **Planned** | `Planned` | `spec`→`product`, `plan`→`planner`, `plan-review`→`reviewer`, `code-review`→`reviewer`; implementation stays in the main loop | `plan-review = "CODEX"`, `code-review = "CODEX"` |
| **Async** | `Async` | the above plus `code`→`coder` — the full fan-out | `plan-review = "CODEX"`, `code-review = "CODEX"` |

- **The main agent is the card's, not the pipeline's** (operator-named
  executor/model → config `executor_profile` → Claude Code). Every delegable
  step inherits it unless the operator binds that step to another agent.
- **A step can run on any of the four agents** — Claude Code, OpenCode, Codex,
  Pi — declared per stage id in `[agents]`, with its model in `[models]`. A
  step bound to an agent other than the main loop renders as a one-shot on that
  agent's own CLI (`claude --print` / `opencode run` / `pi --mode json` /
  `codex exec`, each with `< /dev/null`), run from the main loop, relayed back,
  with a main-loop fallback when the CLI is unavailable.
- **A model belongs to the agent of the step it is bound to** — that is all
  that survives of the old prohibition, and it is now a per-step statement
  rather than a per-pipeline one. A contradiction (a model an agent
  cannot run) is surfaced, never composed.
- **Codex is still the default reviewer** — `Planned` and `Async` ship
  `plan-review`/`code-review` on `CODEX`; a Codex main loop simply makes them
  same-agent. It is a default, overridable per card.

### Default per-step bindings (transposed from the removed per-model pipelines)

| Main agent | spec / plan | coder (`code`) |
|---|---|---|
| **Claude Code** | `sonnet` (light) · `opus` (medium, heavy) | `sonnet` (light, medium) · `opus` (heavy) |
| **OpenCode** | `zai-coding-plan/glm-5.2`, effort `high` | `zai-coding-plan/glm-5.2` |
| **Pi** *(explicit ask only)* | `zai-coding-plan/glm-5.2`, effort `high` | `zai-coding-plan/glm-5.2` |
| **Codex** *(uncalibrated)* | `gpt-5.6-terra` (light) · `gpt-5.6-sol` (medium, heavy) | `gpt-5.6-terra` (light, medium) · `gpt-5.6-sol` (heavy) |

OpenCode and Pi ids must be provider-qualified — the bundled pipelines carry no
`[models] provider`, so a bare `glm-5.2` would go through unresolved. The
`kimi-coding/k3` and `minimax/MiniMax-M3` arms and Claude Code's `fable` are
explicit-ask only (uncalibrated, or measured-weak in MiniMax's case). Effort is
TOML-only: no dialog and no compose-endpoint field carries it, so `effort: high`
is a report note, not a binding.

**The tier → type map (§3, §4) is `trivial → Basic`, `light → Planned`,
`medium → Async`, `heavy → Async` + code-review + `pr`.** The `light → Planned`
rung is a deliberate **re-route** — a light card used to buy a full fan-out on a
cheaper coder and now buys delegated planning with main-loop coding. It is the
only routing-outcome change of the unified-pipeline work and is **flagged for
recalibration** (§7.6).

**Pi is the explicit-ask-only arm.** It runs the same models OpenCode uses via
the `pi` CLI but has **n=0 telemetry** on both boards, so it is deliberately
absent from the auto-routing (executor ladder + tier map) — `classify-task`
never routes to Pi as a main loop or as a step. An operator selects Pi ONLY by
naming `PI`/`PI_HEADED` or asking for a step "on pi"; that explicit ask
overrides the ladder exactly like any operator-named agent. Pi runs a single
conversation with no subagents, so a Pi main loop does its delegable stages
itself and the CODER-MODEL step-up stays inside the GLM / Kimi / MiniMax set.
When Pi accumulates real telemetry it can be promoted into the tier map like any
calibrated arm.

**Codex is uncalibrated but auto-routable — deliberately unlike Pi.** It has
n=0 telemetry too, and its default binding row above mirrors the other agents'
shape rather than any measurement. It is still on the executor ladder and in the
default binding table, because Codex exists precisely for an operator whose only
subscription is ChatGPT: excluding it from auto-routing would leave that operator
naming a pipeline on every card, which is the failure it was added to remove.
Say "Codex main loop, uncalibrated (n=0)" in the routing report so the choice
stays visible; promote the tier boundaries once telemetry lands. A Codex step is
a nested one-shot `codex exec` (Codex has no subagent surface), which needs
network access — a card whose main loop is Codex must run under AUTO or a
sandbox that permits it, or the delegated stages fall back to the main loop.

## 2. The telemetry, with receipts

**Historical — pipeline names below are superseded** (the per-model `Async …`
pipelines were replaced by the three types in §1 on 2026-09-07; see §7.7). The
*measurements* still stand and are what the rubric is calibrated on; only the
labels are stale. Read a name here as "the binding that pipeline encoded", which
is now a per-step agent + model choice on `Planned`/`Async`.

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
  completions; **Pi** (all three `async-pi-*`) n=0 — explicit-ask-only until
  measured.
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
        ┌─ classify-task ──┐  Step 1: MAIN AGENT (executor ladder)
        │ agent → tier →   │  Step 2: tier — S D R N V, 0–2 each, forces
        │ type → bindings  │  Step 3: tier → type, then per-step defaults
        └───────┬──────────┘
   trivial    light      medium     heavy
   Basic      Planned    Async      Async + code-review, pr
                │
                ▼  per-step agent + model bound per delegable stage
                   (reviews default to Codex; anything the operator
                    named for a step wins outright)
                │
                ▼  card carries **Routing:** line + ## Pipeline block (merge ON)
                   composed by POST /api/pipelines/:name/compose
        orchestrator: dependency gate (lanes) → dispatch lighter tiers first
                │
                ▼  runtime, after the plan stage exists:
        PLAN-FACTS → PLAN-GATE (skip the plan review < 40 KB, 0 open
        decisions, unless Routing forces yes; cap 2 passes)
                 → CODER-MODEL (step up within the BOUND AGENT's catalog:
                   sonnet→opus, MiniMax→GLM, terra→sol; operator pin wins)
                │
                ▼  VK-ESCALATE park when grounding contradicts the tier
```

Classification happens **at card creation** (all the signal in one place,
changing the route free); the **coder model and the plan-review decision bind
after the plan exists** — the app freezes `extension_metadata` at creation
with no later re-composition, so late binding lives in the stage prompts and
`prompts/pipeline.md`, not in metadata.

## 4. What shipped where (rollout table)

**2026-09-07 — Unify pipelines with per-step agent and model selection**

| Artifact | Change |
|---|---|
| `pipelines/*.toml` + `scripts/generate_pipeline_overrides.py` | the twelve per-model `Async …` overrides **deleted**; the generated set is now exactly `async.toml`, `basic.toml`, `planned.toml`. The generator's file list and its per-file canonical-clause assertions (`PLAN-FACTS:`, `PLAN-GATE:`, `{{DELEGATE}}`, `merge-record`, plus `CODER-MODEL:` on `async.toml` only) follow the app's three bundled types. |
| `scripts/vibecrew_api.py`, `skills/vibecrew/SKILL.md` | new `pipeline-compose <name>` (`POST /api/pipelines/:name/compose`) with `--enabled-ids/--executor/--model/--stage-agent/--stage-model/--custom-text`; `card-update` gains `--extension-metadata` / `--extension-metadata-file` / `--clear-extension-metadata` (sent pre-serialized, as the server's `String?` column requires) |
| `skills/classify-task/SKILL.md` | Step 1 resolves the **main agent** (the old cross-agent prohibition deleted); Step 3 maps tier → `Basic`/`Planned`/`Async` and adds the per-main-agent default binding table; per-step operator overrides are first class; Routing line gains `[<main agent>]` + the optional `steps:` clause |
| `skills/product-manager/SKILL.md`, `agents/product.md` | the block is composed through the endpoint, not by hand; `extension_metadata` is PATCHed onto the created card; a model pin is validated against the **step's** agent |
| `prompts/pipeline.md` | Routing-line semantics per step; CODER-MODEL steps up within the bound agent's catalog; reviews delegate through the `reviewer` role; the two agent-specific stage names retired in favour of `code` and `plan-review` |
| `CLAUDE.md`, `README.md` | the per-executor split section replaced by "Pipeline types and per-step bindings" (three types, the two binding tables, the four one-shot shapes, `{{agent_name}}`, the compose endpoint) |
| `agents/orchestrator.md` + twins, `agents/assistant.md` + twins, `crew-bundle/` | dispatch example re-pointed to `Planned`; the assistant's model rule is now per step; crew-bundle copies regenerated and `manifest.json` versions bumped |

**2026-08-05 — original routing rollout** *(historical; pipeline names below are
superseded — see §1)*

| Artifact | Change |
|---|---|
| `pipelines/*.toml` (**new**, deployed to `~/.vibecrew/pipelines/`) | override copies of all 10 bundled pipelines (Async Claude ×3, Async OpenCode ×3, Async Pi ×3, Basic): `merge` default-ON everywhere; plan stage emits `PLAN-FACTS`; `plan-review-codex` gains the 40 KB gate + 2-pass cap; `code-subagent` gains the in-family CODER-MODEL check; `merge` gains the artifact gate; spec/plan paperwork never committed (`git rev-parse --git-path info/exclude`). Claude files renamed `async-claude-*` (display `name =` kept — the registry shadows bundled by name). Generator: `scripts/generate_pipeline_overrides.py` (asserts every edit fired, so upstream drift breaks generation, not silently). |
| `skills/classify-task/SKILL.md` | **new** — family ladder, rubric, per-family tier maps, toggles, Routing line |
| `skills/product-manager/SKILL.md` | classify step 5; pipeline routed-by-default, composed from the TOML (numbered stages); **Lanes** section |
| `agents/product.md` | classify-and-route bullet; worktree-truth fix for `SPEC.md` |
| `agents/planner.md` | Plan facts section; `VK-ESCALATE` envelope tripwire; worktree-truth fix |
| `agents/coder.md` | paperwork/named-path commit rule; `VK-ESCALATE` tripwire |
| `prompts/pipeline.md` | numbered-block + `VK-PIPELINE-STAGE` markers; worktree-root truth + exclude rule; Routing semantics + the cross-agent prohibition; PLAN-FACTS/PLAN-GATE/CODER-MODEL; review caps; artifact gate in merge protocol step 3; `VK-ESCALATE` stop condition |
| `prompts/plan.md` | worktree-truth fix + exclude rule |
| `agents/orchestrator.md`, `scripts/orchestrator.prompt.md` | dependency gate (lanes) in readiness; lighter-tiers-first dispatch + tier in report; escalation-park recognition |
| `scripts/vibecrew_api.py`, `skills/vibecrew/SKILL.md` | `card-relationships` / `card-relate` / `card-unrelate` (+ docs; direction blocker→blocked, outgoing-only reads) |
| `CLAUDE.md` | block grammar corrected (numbered + order-instruction + current model-pin literal); the per-executor split + the cross-agent prohibition; routing/late-binding literals; `VK-ESCALATE` defined |

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

1. ~~**Upstream the TOML changes**~~ — **done** (same day). The app's
   `CrewKit/Sources/CrewPipeline/Resources/DefaultPipelines/` now carries the
   edits directly: Claude files renamed `async-claude-*.toml` (display `name =`
   unchanged, which is the registry's shadowing key), merge default-on, the
   PLAN-FACTS / PLAN-GATE / CODER-MODEL late binding, review caps, and the
   artifact gate; all 136 `CrewPipelineTests` pass, including the byte-identity
   check across the Async six. The bundled agent payloads
   (`CrewPlugins/Resources/Plugins/payloads/`) gained the same rules in **both**
   their `claude/` and `opencode/` variants — planner (plan facts +
   `VK-ESCALATE` envelope), coder (`VK-ESCALATE` + paperwork hygiene), product
   (worktree truth) — and `manifest.json` bumps those three to `1.1.0` so the
   Plugin Manager offers them as updates. **The app bundle is now canonical**;
   the deployed `~/.vibecrew/pipelines/` copies shadow it by name and can be
   deleted once the app is rebuilt (`rm ~/.vibecrew/pipelines/*.toml`), with
   the plugin's `pipelines/` + generator kept as the upstreaming tool.
2. ~~**Rename the display names too**~~ — **superseded 2026-09-07.** The
   twelve per-model pipelines were replaced outright by `Basic` / `Planned` /
   `Async`, so the display names are gone rather than renamed. The concern the
   item raised was real and is handled: the app carries a legacy alias table
   (`PipelineLegacyAliases`) mapping every removed display name to `Async` and
   the two removed stage ids to their agent-neutral replacements, so an existing
   card's labels and launch are unchanged. The API does **not** alias — a removed
   name is a 404 — so list pipelines rather than guessing one.

   *(Item 1's closing note is likewise superseded in one detail: the deployed
   `~/.vibecrew/pipelines/` copies must now be deleted rather than left to
   shadow, see §7.7.)*
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
   codex profile) are the highest-leverage unexplored saving. Now cheap to try:
   a reviewer is a per-step agent binding, not a pipeline variant.
6. **Recalibrate the `light → Planned` re-route.** Light cards used to run a
   full fan-out on a cheaper coder and now run delegated planning with main-loop
   coding (§1). It is the only routing-outcome change of the 2026-09-07 work and
   is **unmeasured**: after ~10 light cards, compare fresh tokens, LOC, and
   escalation rate against the pre-change light lane and either keep the rung,
   move light back to `Async`, or split it by R. Until then `classify-task`
   reports it as "recalibration pending".
7. **Delete stale `~/.vibecrew/pipelines/async-*.toml` overrides.** Operators
   who deployed the plugin's old per-model overrides still have those files on
   disk, and a user file shadows the bundled set **by `name =`** — so the twelve
   removed pipelines keep appearing in the picker as user pipelines, indefinitely
   and silently. The fix is one command, `rm ~/.vibecrew/pipelines/async-*.toml`
   (which leaves any genuinely hand-written user pipeline alone); it is
   deliberately **not** automated — the app never deletes an operator's files —
   and is documented in the app's `docs/configuration.md`.
