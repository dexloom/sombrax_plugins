---
name: classify-task
description: >-
  Route a vibe-kanban card: resolve the pipeline FAMILY first (OpenCode vs
  Claude Code — decided by the executor, never mixed: OpenCode pipelines run
  MiniMax/GLM/Kimi models, Claude Code pipelines run Sonnet/Opus/Fable, Codex
  is the shared reviewer for both), then score the task (a rough brief, an
  intake mini-spec, or a full card spec) on five bounded axes to a complexity
  tier — trivial / light / medium / heavy — and map tier → pipeline within
  that family (Quick / Basic / Async Sonnet / Async Opus / Async OpenCode
  GLM), plus the per-stage toggles (spec adopt-vs-write, plan-review
  yes-vs-gate, code-review, merge-vs-PR) and the one-line `**Routing:**`
  record that goes on the card.
  Use this skill WHENEVER a vibe-kanban card is being created or a pipeline is
  being attached and the operator did NOT explicitly name a pipeline — the
  `product-manager` skill and the `intake` agent invoke it right after the
  spec/mini-spec is drafted, and `compose-pipeline` consumes its output. It is
  the SINGLE SOURCE OF TRUTH for the rubric, the tier thresholds, the
  tier→pipeline map, the stage-toggle rules, and the Routing line format. It
  does NOT compose the `## Pipeline` block (that's `compose-pipeline`), write
  specs (`product-manager`), or create/update cards (the caller persists). An
  operator-named pipeline or tier ALWAYS overrides this skill's verdict —
  classification fills silence, it never argues.
---

# classify-task — size the task once, route it everywhere

## What this skill is for

Every card pays for the process it runs, not the process it needs. A card that
names its own fix does not need a spec subagent; a card that already carries a
full PM spec does not need the spec rewritten by a second model; a card that
redesigns a hot path should not be planned by the cheapest one. This skill
converts the task text into one explicit, auditable routing decision at the
moment the card is created — the only moment all the signal (brief, spec,
operator phrasing) is in one place and changing the route costs nothing.

You classify; you do not persist. Hand the tier, the toggles, and the Routing
line back to your caller.

## Inputs

- **The task text** — the best available of: full spec (the `## Task:` render),
  intake mini-spec, or raw brief. Classify the *best* text, so run this after
  the spec is drafted, not before.
- **The operator's request phrasing**, verbatim if available — it carries
  forcing words ("quick", "thorough", a named pipeline, a named model).
- Optionally, a couple of cheap repo lookups the caller already made (does a
  template for this exist; is the named file real). Never start a code
  exploration session just to classify — if an axis can't be scored from the
  text, score it 1 and say so in the report.

## Step 1 — resolve the FAMILY (before any scoring)

Pipelines come in two families, split by executor, **never mixed**:

| Family | Executor pin | Build models (spec/plan/code) | Pipelines |
|---|---|---|---|
| **Claude Code** | `CLAUDE_CODE` | Sonnet / Opus / Fable — only these | Async Sonnet, Async Opus, Async Fable |
| **OpenCode** | `OPENCODE` | MiniMax / GLM / Kimi — only these | Async OpenCode GLM (self-drive) |

**Quick** and **Basic** are family-neutral (no baked-in models); on an
OpenCode card they carry the `OPENCODE` executor pin. **Codex is the shared
reviewer** — plan/diff review stages run Codex in BOTH families, never as a
build model. **The never-mix invariant:** no stage, pin, or advice may name a
model from the other family; if the operator's words contradict the family
(an OpenCode pipeline *and* an Opus model), surface the contradiction and
follow the pipeline's family — never compose a mixed binding.

Resolution ladder, first hit wins:

1. **Operator names a pipeline** → that pipeline's family, done.
2. **Operator names an executor or a family model** ("on opencode", "with
   glm", "on sonnet") → that family; a model name implies its family.
3. **The config's last-used/default executor** (`/api/config`) → its family.
4. Nothing resolvable → **Claude Code**.

## The five axes — score each 0 / 1 / 2

Score from the task text. When genuinely torn between two values, take the
**higher** one — misrouting up wastes some tokens, misrouting down risks
rework, and rework is the more expensive failure.

**S — Scope surface.** How much code changes.
- 0: one file/config/copy change, or a single named function.
- 1: a few files inside one package/module.
- 2: a new package/crate/service, several subsystems, or more than one repo.

**D — Decision openness.** How much is still undecided.
- 0: the fix/change is fully named in the text (exact file, flag, env var,
  endpoint); nothing left to choose.
- 1: the approach is clear but details need settling while working (which
  helper, exact schema, the root cause of a described bug).
- 2: open design decisions, unknowns that need research or probing first, or
  "rethink/redesign" verbs whose outcome is settled but whose shape is not.

**R — Risk / blast radius.** Cost of getting it wrong.
- 0: isolated and trivially revertible.
- 1: shared code paths, persisted data shapes, public interfaces other code
  consumes.
- 2: irreversible or expensive-to-reverse effects — data migrations, funds /
  trading / order-execution paths, auth or security surface, hot-path latency,
  or a deliverable that gates a major downstream decision.

**N — Novelty.** How much precedent the repo offers.
- 0: a template/sibling exists to clone (a venue package next to an existing
  one, an endpoint next to ten identical ones).
- 1: a variation on existing patterns.
- 2: genuinely new design — new algorithm, new infra, no in-repo precedent.

**V — Verification cost.** How hard "done" is to prove.
- 0: obvious at a glance or via the existing checks (page renders, suite
  passes).
- 1: needs targeted new tests or a focused manual check.
- 2: needs a soak, benchmark, determinism proof, multi-day window, or a
  written verdict/report as the deliverable.

## Hard overrides — applied before and after scoring

Operator word first, then forcing triggers, then the score:

1. **Operator names a pipeline, model, or tier** ("execute Async Fable", "run
   it quick", "full treatment", "on sonnet") → use it verbatim; still score
   the axes and note any disagreement in the report ("routed Async Fable by
   operator; rubric says medium/4"). Never argue, never silently re-route.
2. **Force-trivial:** typo / rename / version bump / doc tweak / dependency
   bump, or a fix whose exact location and change are both named — *and*
   R = 0. → tier `trivial` regardless of the other axes.
3. **Force-heavy:** any of — irreversible data migration; funds, trading, or
   order-execution behavior; auth/security surface; a cross-repo or protocol
   change; N = 2 *and* R = 2 together. → tier `heavy` regardless of total.

## Thresholds → tier

Total = S + D + R + N + V (0–10).

| Total | Tier |
|---|---|
| ≤ 1, with D = 0 and R = 0 | **trivial** |
| ≤ 3 (or ≤ 1 failing the D/R condition) | **light** |
| 4 – 6 | **medium** |
| ≥ 7 | **heavy** |

## Tier → pipeline, within the family

Telemetry-revised 2026-08-05 (evidence in `reference/routing.md` §9): full
ceremony on GLM costs ~507K fresh tokens — the "ceremony tax" that made
mid-size cards avoid async pipelines was a model-price artifact; the strongest
blowup predictor is plan size (~40 KB), which is why plan-review and the coder
model now bind **after the plan exists** (the PLAN-GATE / CODER-MODEL runtime
checks), not here.

| Tier | Claude Code family | OpenCode family |
|---|---|---|
| **trivial** | **Quick** | **Quick** + `OPENCODE` executor pin |
| **light** | **Async Sonnet** | **Async OpenCode GLM** |
| **medium** | **Async Opus** (opus spec/plan, sonnet coder) | **Async OpenCode GLM** |
| **heavy** | **Async Opus** + code-review, `pr` instead of `merge` | **Async OpenCode GLM** + code-review, `pr` instead of `merge` |

- **Async Fable is an explicit-ask arm only** (zero completed-card telemetry;
  heavy routes to Async Opus until Fable is calibrated). Likewise the
  OpenCode MiniMax/Kimi arms exist only in VibeCrew and are measured-weak /
  uncalibrated — route to them only when the operator names them, and say so.
- The pipeline files in `~/.vibe-kanban/pipelines/*.toml` are the source of
  truth for stage prompts (Claude family files are named `async-claude-*`;
  the display `name =` values are unchanged); you name the pipeline and the
  toggles, and `compose-pipeline` reads the files and renders the block. If
  the routed pipeline file is missing on disk, report that and route one tier
  **up** to the nearest existing pipeline — never invent stages.

## Stage toggles — orthogonal to tier

Report each of these explicitly; `compose-pipeline` applies the add/drop ones
as overrides against the pipeline's `default_enabled` set.

- **spec:** `adopt` when the card description already passes the full-spec test
  (`### Outcome`, `### Scope`, and `### Testing & acceptance criteria` each at
  the start of a line — the same test the spec stage prompt applies) — the
  Async spec stages detect this themselves and copy the description through to
  `SPEC.md` instead of spawning a subagent, so no add/drop is needed; the
  toggle records the *expectation* so a mis-detect is visible. `write` when the
  description is not a full spec. `skip` only in Quick (which has no spec
  stage). A card created by the `product` agent is always full-spec → always
  `adopt`: never pay a spec subagent to rewrite a spec that exists.
- **plan:** `skip` for trivial (Quick has no plan stage); `yes` for everything
  else.
- **plan-review (Codex):** `yes` (forced) when R = 2; otherwise **`gate`** —
  keep the stage listed and let the runtime PLAN-GATE decide after the plan
  exists (it skips the review when the plan is under ~40 KB with 0 open
  decisions, and caps it at two passes). Never drop the stage outright: that
  would blind the gate. Plan size after grounding, not tier before it, is the
  measured blowup predictor.
- **code-review (Codex):** `yes` (add the stage) for heavy, and for medium when
  R ≥ 1; otherwise `no`. The runtime caps it at two passes either way.
- **completion:** `merge` — the default; every deployed pipeline now ticks it
  (squash-merge is the default delivery) — for R ≤ 1; **`pr`** (un-tick
  merge, tick the PR stage — a human gate) for heavy or R = 2.
- **coder model:** not decided here — the runtime CODER-MODEL check binds it
  after the plan, within the family (sonnet→opus step-up on a blown plan; the
  OpenCode self-drive pipeline is single-model by construction). Record the
  family default in the Routing line as `coder: post-plan(<default>)`.
- **orchestrate:** not yours — the explicit-execute gate belongs to
  `compose-pipeline` and its caller, unchanged by classification.

## The Routing line — the durable record

Hand back exactly one line, to be placed in the card description directly
**above** the `## Pipeline` block (outside its delimiters — nothing is ever
added inside them):

```
**Routing:** <tier> → <pipeline> [<Claude Code|OpenCode>] — S<s> D<d> R<r> N<n> V<v> = <total><; forced by <trigger|operator>>; spec: <adopt|write|skip>; plan: <yes|skip>; plan-review: <yes|gate>; code-review: <yes|no>; completion: <merge|pr>; coder: post-plan(<default model>)
```

Example:

```
**Routing:** medium → Async Opus [Claude Code] — S2 D1 R0 N0 V1 = 4; spec: adopt; plan: yes; plan-review: gate; code-review: no; completion: merge; coder: post-plan(sonnet)
```

This line is what makes routing auditable and tunable: when the card is done,
the actuals (cycle time, transcript size, escalations, re-spawns) are compared
against it — see `reference/routing.md`. If the spec-adopt fast path later
copies the description into `SPEC.md`, the line riding along is harmless
context — do not engineer it away.

## Escalation is the safety valve, not you

Classify from the text you have and move on — do not agonize. The `planner`
and `coder` agents carry a `VK-ESCALATE` tripwire: when grounding reveals the
task is bigger than its tier (an oversized plan, a broken assumption, an
unpriced design decision), they say so loudly instead of pushing through, and
the card gets re-routed one tier up. A cheap first route plus a loud tripwire
beats an expensive route taken "just in case". Route down when the scores say
so; trust the tripwire.

## Report facts (hand these to your caller)

- The **family** and which ladder rung resolved it (named pipeline / named
  executor-or-model / config default / fallback), plus any operator/family
  contradiction you surfaced.
- The tier, the five axis scores and total, and any override that fired
  (operator / force-trivial / force-heavy), with one-phrase evidence.
- The routed pipeline and every stage toggle.
- The composed Routing line, verbatim.
- Any axis scored 1 for lack of signal, named plainly.

## Worked micro-examples

- *"401 from x.ai when updating thesis — we should use `XAI_API_KEY` env var"*
  → S0 D0 R0 N0 V0 = 0 → **trivial → Quick**. (Historically this card ran a
  spec stage plus a coder subagent — pure overhead.)
- *"Markets page doesn't render content"* → S0 D1 (cause unknown) R0 N0 V0 =
  1, D ≠ 0 → **light**; Claude executor → **Async Sonnet**, spec: write,
  plan-review: gate.
- *"Add Limitless as a fourth venue, cloning the `polymarket/` package; L0
  probe first"* → S2 D1 R0 N0 V1 = 4 → **medium**; OpenCode default executor
  → **Async OpenCode GLM [OpenCode]**, spec: adopt (full PM spec already on
  the card), code-review: no.
- *"Backtest replay engine + depth-aware fill sim + reports/CLI"* → S2 D2 R1
  N2 V2 = 9 → **heavy → Async Opus [Claude Code]** + code-review, completion:
  pr. (Async Fable only if the operator names it — uncalibrated.)
