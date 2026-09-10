---
name: classify-task
description: >-
  Route a VibeCrew card: resolve the MAIN AGENT first (Claude Code / OpenCode /
  Codex / Pi — decided by the executor), then score the task on five bounded
  axes to a complexity tier — trivial / light / medium / heavy — and map tier →
  pipeline type (Basic / Planned / Async) plus the per-step agent and model
  defaults, the stage toggles (plan-review yes-vs-gate, code-review,
  merge-vs-pr) and the one-line `**Routing:**` record for the card. Use this
  skill WHENEVER a vibecrew card is being created or a pipeline attached and
  the operator did NOT explicitly name a pipeline — the `product-manager` skill
  and the `product` agent invoke it right after the spec is drafted. It is the
  SINGLE SOURCE OF TRUTH for the main-agent ladder, the rubric, the tier→type
  map, the default per-step binding table, the toggle rules, and the Routing
  line format. It does NOT compose the `## Pipeline` block (the caller does,
  through `POST /api/pipelines/:name/compose`), write specs, or create cards.
  An operator-named pipeline, executor, model, per-step binding, or tier ALWAYS
  overrides this skill's verdict — classification fills silence, it never
  argues.
---

# classify-task — main agent first, then tier, telemetry-grounded

## What this skill is for

Every card pays for the process it runs, not the process it needs. This skill
converts the task text plus the executor context into one explicit, auditable
routing decision at card creation — main agent, pipeline type, per-step
bindings, toggles — and records it on the card. The evidence behind every
threshold here is the measured board telemetry summarized in
`reference/routing.md`; when you change a rule, change it there too, with
numbers.

You classify; you do not persist. Hand the main agent, tier, pipeline type,
per-step bindings, toggles, and Routing line back to your caller.

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

## Step 1 — resolve the MAIN AGENT (before any scoring)

Every card runs on one **main agent** — the executor its main loop launches
with. There are four, and each one can also be bound to an individual step:

| Main agent | Executor | Model catalog |
|---|---|---|
| **Claude Code** | `CLAUDE_CODE_HEADED` | Sonnet / Opus / Fable |
| **OpenCode** | `OPENCODE_HEADED` | `zai-coding-plan/glm-5.2`, `minimax/MiniMax-M3`, `kimi-coding/k3` |
| **Pi** *(explicit-ask-only, uncalibrated)* | `PI_HEADED` | same provider-qualified ids as OpenCode |
| **Codex** *(uncalibrated, n=0 — but auto-routable)* | `CODEX_HEADED` | `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` |

- The three bundled pipelines are **agent-neutral**: `Basic`, `Planned`, and
  `Async` carry no executor binding and no model table, so every delegable step
  inherits the main agent unless a step is bound to another one. The main agent
  is therefore the seed for the whole card, not a pipeline property.
- **A step may run on a different agent than the main loop.** `[agents]` names
  the agent per stage id, `[models]` the model; the runtime renders a one-shot
  clause on that step's own CLI, run from the main loop. That is a supported,
  first-class configuration — spec on Claude Code, plan on Codex, code on Pi is
  a legal card.
- **A model belongs to the agent of the step it is bound to.** Pinning
  `gpt-5.6-sol` on a step means that step runs on Codex; pinning `opus` on a
  step means Claude Code. If the operator's words pair a model with an agent
  that cannot run it, surface the contradiction in your report rather than
  composing it.
- **Codex is the default reviewer.** `Planned` and `Async` ship with
  `plan-review` and `code-review` bound to `CODEX`. Leave them there unless the
  operator says otherwise; on a Codex main loop they are simply same-agent.
- **Pi is explicit-ask-only and uncalibrated.** It shares OpenCode's provider
  catalog (GLM / Kimi / MiniMax via the `pi` CLI) but has **no telemetry**
  (n = 0), is **not** on the resolution ladder below, and is never auto-routed —
  as a main agent or as a step binding. An operator selects Pi ONLY by naming a
  `PI`/`PI_HEADED` executor or asking for a step "on pi"; an explicit Pi ask
  always wins, the same override rule as any agent.
- **Codex is uncalibrated but auto-routable.** It has no completed-card
  telemetry either (n = 0), but unlike Pi it IS on the ladder and IS in the
  default binding table: an operator whose default executor is Codex — typically
  because a ChatGPT subscription is the only thing they have — must get a working
  route without naming a pipeline every time. Say "Codex main loop, uncalibrated
  (n=0)" in the report so the choice is visible.

Resolution ladder, first hit wins:

1. **Operator names a pipeline** → that pipeline's own `agent =` when it has
   one (user pipelines may pin one); the bundled three do not, so fall through
   to the next rung for the main agent and keep the named pipeline as the type.
2. **Operator names an executor or a model** ("on opencode", "with glm", "on
   sonnet", "on pi", "on codex", "with gpt-5.6") → that agent. A model name
   implies the agent that runs it.
3. **The config's default executor** (`vibecrew_api.py config` →
   `executor_profile`): `OPENCODE*` → OpenCode; `CLAUDE*` → Claude Code;
   `CODEX*` → Codex; `PI*` → Pi.
4. Nothing resolvable → **Claude Code** (the app's own final fallback).

**Per-step overrides are first class.** An operator naming an agent or a model
*for a step* — "plan on codex", "code on pi", "review with sonnet" — is not a
main-agent signal and must not move rung 2. Record it as a per-step binding on
that stage id and carry it into the Routing line's `steps:` clause; it overrides
the default binding table in Step 3 exactly the way a named pipeline overrides
the tier map.

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

1. **Operator names a pipeline, model, executor, tier, or per-step binding** →
   use it verbatim; still score and note any disagreement ("routed Basic by
   operator; rubric says medium/4"). Never argue, never silently re-route.
2. **Force-trivial:** typo / rename / version bump / doc tweak / dependency
   bump, or a fix whose exact location and change are both named — *and*
   R = 0 → tier `trivial`.
3. **Force-heavy:** irreversible data migration; funds/trading/order
   execution; auth/security surface; cross-repo or protocol change; or
   N = 2 *and* R = 2 → tier `heavy`.

Total = S+D+R+N+V. **trivial**: ≤ 1 with D = 0 and R = 0 · **light**: ≤ 3 ·
**medium**: 4–6 · **heavy**: ≥ 7.

## Step 3 — tier → pipeline type, then the default bindings

Telemetry receipts (details in `reference/routing.md`): Basic ships a light
card for ~191K fresh tokens; a full fan-out costs ~507K fresh (the old
"ceremony tax" was a model-price artifact); GLM-5.2 is the most efficient
measured coder; MiniMax-M3 is the weak arm (worst fresh/LOC, needed a follow-up
debug card); Fable and the Kimi arm have **zero** completed-card data. Hence:

| Tier | Pipeline type | Shape |
|---|---|---|
| **trivial** | **Basic** + executor pin | default state: implement + merge, no delegation |
| **light** | **Planned** | delegated spec → plan → plan review; the main loop writes the code |
| **medium** | **Async** | full fan-out: spec → plan → plan review → code → code review |
| **heavy** | **Async** | + code-review ticked, `pr` instead of `merge` |

- **`light → Planned` is a deliberate re-route** and the only routing-outcome
  change of the unified-pipeline card: a light task used to buy a full fan-out
  on a cheaper coder, and now buys delegated planning with main-loop coding.
  It is **flagged for recalibration** — see `reference/routing.md` §7 — so say
  "light → Planned (recalibration pending)" in the report until telemetry lands.
- Pipeline source of truth: the app's bundled set plus `~/.vibecrew/pipelines/*.toml`
  (user files shadow bundled pipelines by `name =`). Confirm with
  `vibecrew_api.py pipelines` when unsure; never invent stages, and never guess
  a name — the removed per-model pipeline names no longer resolve.

### Default per-step bindings

Once the type is chosen, bind the delegable steps. These defaults transpose the
per-model pipelines this card's design replaced; they are **defaults, not
rules** — any operator word about a step wins outright.

| Main agent | spec / plan | coder (`code`) | reviews (`plan-review`, `code-review`) |
|---|---|---|---|
| **Claude Code** | `sonnet` (light) · `opus` (medium, heavy) | `sonnet` (light, medium) · `opus` (heavy) | `CODEX` |
| **OpenCode** | `zai-coding-plan/glm-5.2`, effort `high` | `zai-coding-plan/glm-5.2` | `CODEX` |
| **Pi** *(explicit ask only)* | `zai-coding-plan/glm-5.2`, effort `high` | `zai-coding-plan/glm-5.2` | `CODEX` |
| **Codex** *(uncalibrated)* | `gpt-5.6-terra` (light) · `gpt-5.6-sol` (medium, heavy) | `gpt-5.6-terra` (light, medium) · `gpt-5.6-sol` (heavy) | `CODEX` (same agent) |

- **OpenCode and Pi model ids are provider-qualified.** The bundled pipelines
  carry no `[models] provider`, so a bare `glm-5.2` would be passed through
  unresolved — always write `zai-coding-plan/glm-5.2`. The `kimi-coding/k3` and
  `minimax/MiniMax-M3` arms are explicit-ask only (Kimi uncalibrated, MiniMax
  measured-weak); Claude Code's `fable` is likewise explicit-ask (n = 0).
- **A step with no model binding inherits.** Same agent as the main loop ⇒ it
  inherits the card's model; a different agent ⇒ that CLI's own default. Leaving
  a step unbound is a legitimate choice — bind only what the tier table above
  or the operator actually calls for.
- **Reviews stay on Codex** unless the operator says otherwise; that is already
  the shipped `[agents]` default of `Planned` and `Async`, so it needs no
  `--stage-agent` flag.
- **Effort is TOML-only.** There is no per-step effort control in any dialog or
  in the compose endpoint, so `effort: high` for an OpenCode/Pi spec or plan is
  something you **record in the report** (and an operator can pin in a user
  pipeline's `[effort]` table) — never something you pass as a binding.

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
  after the plan exists, stepping up **within the bound agent's own catalog**
  (Claude Code: sonnet → opus; OpenCode/Pi: MiniMax-M3 → glm-5.2; Codex:
  gpt-5.6-terra → gpt-5.6-sol) when the plan blows its envelope. Record the
  Step 3 default in the Routing line as `coder: post-plan(<agent>/<model>)`,
  naming the agent the `code` step is bound to. `Planned` has no `code` stage —
  its coder is the main loop, so record `coder: main-loop(<main agent>)`.
- **orchestrate:** not yours — the auto-drive opt-in requires the operator's
  explicit ask to execute, unchanged by routing.

## The Routing line — the durable record

Hand back exactly one line, placed in the card description directly **above**
the `## Pipeline` block (outside its delimiters):

```
**Routing:** <tier> → <Basic|Planned|Async> [<main agent>] — S<s> D<d> R<r> N<n> V<v> = <total><; forced by <trigger|operator>>; spec: <adopt|write|skip>; plan-review: <yes|gate>; code-review: <yes|no>; completion: <merge|pr>; coder: post-plan(<agent>/<model>)<; steps: spec=<agent>/<model>, plan=…, plan-review=…, code=…, code-review=…>
```

The bracket is the **main agent**, not a pipeline property. Append the `steps:`
clause **only when at least one step differs from the main agent** (a different
agent, or a model the main loop would not have used); list just those steps,
`<agent>/<model>` each, `<agent>/-` when only the agent is bound. Omit the whole
clause when every step inherits.

Examples:

```
**Routing:** medium → Async [OpenCode] — S2 D1 R0 N0 V1 = 4; spec: write; plan-review: gate; code-review: no; completion: merge; coder: post-plan(OpenCode/zai-coding-plan/glm-5.2); steps: plan-review=Codex/-, code-review=Codex/-
```

```
**Routing:** medium → Async [Claude Code] — S2 D1 R1 N1 V1 = 6; spec: write; plan-review: gate; code-review: yes; completion: merge; coder: post-plan(Pi/kimi-coding/k3); steps: plan=Codex/gpt-5.6-sol, plan-review=OpenCode/-, code=Pi/kimi-coding/k3, code-review=Codex/-
```

The second line is the card's own worked example — a Claude Code main loop with
planning on Codex, plan review on OpenCode, and coding on Pi — and every one of
those bindings is an operator ask, not a default.

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
  merge), executor pinned to the resolved main agent. (Historically this card
  ran a spec stage plus a coder subagent — pure overhead.)
- *"Markets page doesn't render content"* → S0 D1 (cause unknown) R0 N0 V0 =
  1, D ≠ 0 → **light**; Claude Code main agent → **Planned [Claude Code]**,
  spec/plan on `sonnet`, reviews on Codex (the shipped default), spec: write,
  plan-review: gate, coder: main-loop(Claude Code). Flag the light → Planned
  re-route as recalibration-pending.
- *"Add Limitless as a fourth venue, cloning the `polymarket/` package; L0
  probe first"* → S2 D1 R0 N0 V1 = 4 → **medium → Async [OpenCode]** (default
  executor), spec/plan and coder on `zai-coding-plan/glm-5.2`, reviews on Codex,
  spec: adopt (full PM spec already on the card), code-review: no.
- *"Backtest replay engine + depth-aware fill sim + reports/CLI"* → S2 D2 R1
  N2 V2 = 9 → **heavy → Async [Claude Code]** + code-review, completion: pr,
  spec/plan and coder on `opus`. (`fable` only if the operator names it —
  uncalibrated.)
- *"Rethink the pipeline architecture — spec on Claude, plan on codex with
  gpt-5.6-sol, plan review on opencode, code on pi"* → the tier still comes from
  the rubric, but every named step is a first-class per-step override: main
  agent Claude Code (rung 2 is silent about the main loop, so the config default
  or the fallback decides), and the `steps:` clause carries
  `plan=Codex/gpt-5.6-sol, plan-review=OpenCode/-, code=Pi/-`. Pi is auto-routed
  never, asked-for always.

## Report facts (hand these to your caller)

- The **main agent** and which ladder rung resolved it.
- The tier, five axis scores and total, any override that fired, with
  one-phrase evidence.
- The routed pipeline type and every stage toggle.
- The **per-step bindings**: agent and model per delegable stage id, marked
  `default` (from the Step 3 table), `operator` (an explicit ask), or `inherit`
  — plus any `effort` you would have set, since effort is TOML-only and cannot
  be passed as a binding.
- The composed Routing line, verbatim.
- Any axis scored 1 for lack of signal, named plainly; any contradiction you
  surfaced between an operator's words and the agent a model belongs to.
