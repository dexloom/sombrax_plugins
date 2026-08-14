---
name: classify-task
description: >-
  Route a VibeCrew card: resolve the pipeline FAMILY first (OpenCode vs Claude
  Code — decided by the executor, never mixed), then score the task on five
  bounded axes to a complexity tier — trivial / light / medium / heavy — and
  map tier → pipeline within that family (Basic / Async Sonnet / Async Opus /
  Async OpenCode GLM), plus the stage toggles (plan-review yes-vs-gate,
  code-review, merge-vs-pr) and the one-line `**Routing:**` record for the
  card. Use this skill WHENEVER a vibecrew card is being created or a pipeline
  attached and the operator did NOT explicitly name a pipeline — the
  `product-manager` skill and the `product` agent invoke it right after the
  spec is drafted. It is the SINGLE SOURCE OF TRUTH for the family rule, the
  rubric, the tier→pipeline maps, the toggle rules, and the Routing line
  format. It does NOT compose the `## Pipeline` block (the caller does, from
  the pipeline TOML), write specs, or create cards. An operator-named
  pipeline, executor, model, or tier ALWAYS overrides this skill's verdict —
  classification fills silence, it never argues.
---

# classify-task — family first, then tier, telemetry-grounded

## What this skill is for

Every card pays for the process it runs, not the process it needs. This skill
converts the task text plus the executor context into one explicit, auditable
routing decision at card creation — family, pipeline, toggles — and records it
on the card. The evidence behind every threshold here is the measured board
telemetry summarized in `reference/routing.md`; when you change a rule, change
it there too, with numbers.

You classify; you do not persist. Hand the family, tier, toggles, and Routing
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

VibeCrew pipelines come in three families, split by executor, **never mixed**:

| Family | Executor | Build models (spec/plan/code) | Pipelines |
|---|---|---|---|
| **Claude Code** | `CLAUDE_CODE_HEADED` | Sonnet / Opus / Fable — only these | Async Sonnet, Async Opus, Async Fable |
| **OpenCode** | `OPENCODE_HEADED` | MiniMax / GLM / Kimi — only these | Async OpenCode GLM, Async OpenCode GLM-MiniMax, Async OpenCode Kimi-MiniMax |
| **Pi** *(explicit-ask-only, uncalibrated)* | `PI_HEADED` | GLM / Kimi / MiniMax — only these | Async Pi GLM, Async Pi GLM-MiniMax, Async Pi Kimi-MiniMax |

- **Basic** is family-neutral (no executor binding, no model table): it runs
  on whichever executor the card pins or the config defaults to.
- **Codex is the shared reviewer** — `plan-review-codex` / `code-review` run
  on Codex in EVERY family. Codex is never a build model.
- **The never-mix invariant:** no stage, pin, or advice may name a model from
  another family. A Claude Code card never runs a GLM coder; an OpenCode
  card never runs an Opus coder. If the operator's words contradict the
  family (e.g. names an OpenCode pipeline *and* an Opus model), surface the
  contradiction in your report and follow the pipeline's family — never
  compose a mixed binding.
- **Pi is explicit-ask-only and uncalibrated.** It shares OpenCode's model
  set (GLM / Kimi / MiniMax, via the `pi` CLI) but has **no telemetry** (n=0)
  and is **not** on the resolution ladder below and **not** in the tier→pipeline
  maps in Step 3 — you NEVER auto-route to Pi. An operator selects Pi ONLY by
  naming a `async-pi-*` pipeline or a `PI`/`PI_HEADED` executor (step 1/2 of the
  ladder); an explicit Pi ask always wins, the same override rule as any family.

Resolution ladder, first hit wins:

1. **Operator names a pipeline** → that pipeline's family, done (a `async-pi-*`
   name → Pi).
2. **Operator names an executor or a family model** ("on opencode", "with
   glm", "on sonnet", "on pi") → that family. A model name implies its family.
3. **The config's default executor** (`vibecrew_api.py config` →
   `executor_profile`): `OPENCODE*` → OpenCode; `CLAUDE*` → Claude Code.
4. Nothing resolvable → **Claude Code** (the app's own final fallback).

## Step 2 — the five axes, scored 0 / 1 / 2

Score from the best task text available (full spec > mini-spec > brief).
When torn between two values, take the **higher** — misrouting up wastes some
tokens; misrouting down risks rework, the expensive failure.

- **S — Scope surface.** 0: one file/config/copy change. 1: a few files in
  one package/module. 2: a new package/service, several subsystems, or more
  than one repo.
- **D — Decision openness.** 0: the change is fully named (exact file, flag,
  endpoint). 1: approach clear, details to settle while working. 2: open
  design decisions, research needed, "rethink/redesign" verbs.
- **R — Risk / blast radius.** 0: isolated, trivially revertible. 1: shared
  code paths, persisted data shapes, public interfaces. 2: irreversible or
  expensive-to-reverse — data migrations, funds/trading paths, auth/security
  surface, hot-path latency, or a deliverable gating a major decision.
- **N — Novelty.** 0: a template/sibling exists to clone. 1: a variation on
  existing patterns. 2: genuinely new design, no in-repo precedent.
- **V — Verification cost.** 0: obvious at a glance / existing checks.
  1: targeted new tests or a focused manual check. 2: soak, benchmark,
  determinism proof, or a written verdict as the deliverable.

**Hard overrides**, applied around the score:

1. **Operator names a pipeline, model, executor, or tier** → use it verbatim;
   still score and note any disagreement ("routed Async Fable by operator;
   rubric says medium/4"). Never argue, never silently re-route.
2. **Force-trivial:** typo / rename / version bump / doc tweak / dependency
   bump, or a fix whose exact location and change are both named — *and*
   R = 0 → tier `trivial`.
3. **Force-heavy:** irreversible data migration; funds/trading/order
   execution; auth/security surface; cross-repo or protocol change; or
   N = 2 *and* R = 2 → tier `heavy`.

Total = S+D+R+N+V. **trivial**: ≤ 1 with D = 0 and R = 0 · **light**: ≤ 3 ·
**medium**: 4–6 · **heavy**: ≥ 7.

## Step 3 — tier → pipeline, within the family

Telemetry receipts (details in `reference/routing.md`): Basic ships a light
card for ~191K fresh tokens; full ceremony on Async OpenCode GLM costs ~507K
fresh (the old "ceremony tax" was a model-price artifact); GLM-5.2 is the
most efficient measured coder; MiniMax-M3 is the weak arm (worst fresh/LOC,
needed a follow-up debug card); Async Fable and the Kimi arm have **zero**
completed-card data. Hence:

| Tier | Claude Code family | OpenCode family |
|---|---|---|
| **trivial** | **Basic** (default state: implement + merge) | **Basic** + executor pin `OPENCODE_HEADED` |
| **light** | **Async Sonnet** | **Async OpenCode GLM** |
| **medium** | **Async Opus** | **Async OpenCode GLM** |
| **heavy** | **Async Opus** + code-review, `pr` instead of `merge` | **Async OpenCode GLM** + code-review, `pr` instead of `merge` |

- **Async Fable, GLM-MiniMax, and Kimi-MiniMax are explicit-ask arms only** —
  Fable and Kimi are uncalibrated (n = 0) and MiniMax is measured-weak; route
  to them only when the operator names them, and say so in the report.
- Pipeline source of truth: `~/.vibecrew/pipelines/*.toml` (the plugin's
  deployed overrides; user files shadow bundled pipelines by `name =`). If a
  routed pipeline file is missing there AND the app's bundled set lacks it,
  route one tier up to the nearest existing pipeline and report it — never
  invent stages.

## Step 4 — stage toggles (orthogonal to tier)

Report each explicitly; the caller applies them against the pipeline's
`default_enabled` set when composing the block.

- **spec:** `adopt` when the card description already passes the full-spec test
  (`### Outcome`, `### Scope`, and `### Testing & acceptance criteria` each at
  the start of a line — the same test the async spec stage applies) — the spec
  stage detects this itself and copies the description through to `SPEC.md`
  instead of spawning a subagent, so no add/drop is needed; the toggle records
  the *expectation* so a mis-detect is visible. `write` when the description is
  not a full spec. `skip` only for trivial (Basic has no spec stage). A card
  created by the `product` agent is always full-spec → always `adopt`: never
  pay a spec subagent to rewrite a spec that exists.
- **plan-review:** `yes` (forced) when R = 2; otherwise **`gate`** — the
  stage stays listed and the runtime PLAN-GATE decides after the plan exists
  (skip when the plan is under ~40 KB with 0 open decisions). Never `no`:
  dropping the stage would blind the gate. Measured basis: plan size ≥ ~40 KB
  is the strongest blowup predictor on the board; a codex plan review
  routinely costs more than the plan itself.
- **code-review:** `yes` (tick the stage) for heavy, and for medium when
  R ≥ 1; otherwise `no`. Runtime caps it at two passes either way.
- **completion:** `merge` (the default — every deployed pipeline now ticks
  it) for R ≤ 1; **`pr`** for heavy or R = 2 — un-tick `merge`, tick `pr`, a
  human gate before landing.
- **coder model:** NOT decided here — the runtime CODER-MODEL check binds it
  after the plan exists, within the family (sonnet→opus / MiniMax→GLM step-up
  on blown plans). Record the pipeline's default in the Routing line as
  `coder: post-plan(<default>)`.
- **orchestrate:** not yours — the auto-drive opt-in requires the operator's
  explicit ask to execute, unchanged by routing.

## The Routing line — the durable record

Hand back exactly one line, placed in the card description directly **above**
the `## Pipeline` block (outside its delimiters):

```
**Routing:** <tier> → <pipeline> [<Claude Code|OpenCode>] — S<s> D<d> R<r> N<n> V<v> = <total><; forced by <trigger|operator>>; spec: <adopt|write|skip>; plan-review: <yes|gate>; code-review: <yes|no>; completion: <merge|pr>; coder: post-plan(<default model>)
```

Example:

```
**Routing:** medium → Async OpenCode GLM [OpenCode] — S2 D1 R0 N0 V1 = 4; spec: write; plan-review: gate; code-review: no; completion: merge; coder: post-plan(glm-5.2)
```

The runtime reads two things from it: `plan-review: yes` forces the PLAN-GATE
open, and the tier is the plan-size envelope the escalation tripwire checks.
Everything else is audit trail for the telemetry feedback loop.

## Escalation is the safety valve, not you

Classify from the text and move on. The planner/coder carry a `VK-ESCALATE`
tripwire (defined in the plugin's `CLAUDE.md`): when grounding contradicts
the tier — an oversized plan, a broken assumption, an unpriced design
decision — they park loudly and the card is re-routed one tier up. A cheap
first route plus a loud tripwire beats an expensive route taken "just in
case".

## Worked micro-examples

- *"401 from x.ai when updating thesis — we should use `XAI_API_KEY` env var"*
  → S0 D0 R0 N0 V0 = 0 → **trivial → Basic** (default state: implement +
  merge). (Historically this card ran a spec stage plus a coder subagent — pure
  overhead.)
- *"Markets page doesn't render content"* → S0 D1 (cause unknown) R0 N0 V0 =
  1, D ≠ 0 → **light**; Claude executor → **Async Sonnet**, spec: write,
  plan-review: gate.
- *"Add Limitless as a fourth venue, cloning the `polymarket/` package; L0
  probe first"* → S2 D1 R0 N0 V1 = 4 → **medium**; OpenCode default executor
  → **Async OpenCode GLM [OpenCode]**, spec: adopt (full PM spec already on the
  card), code-review: no.
- *"Backtest replay engine + depth-aware fill sim + reports/CLI"* → S2 D2 R1
  N2 V2 = 9 → **heavy → Async Opus [Claude Code]** + code-review, completion:
  pr. (Async Fable only if the operator names it — uncalibrated.)

## Report facts (hand these to your caller)

- The **family** and which ladder rung resolved it.
- The tier, five axis scores and total, any override that fired, with
  one-phrase evidence.
- The routed pipeline and every stage toggle.
- The composed Routing line, verbatim.
- Any axis scored 1 for lack of signal, named plainly; any operator/family
  contradiction you surfaced.
