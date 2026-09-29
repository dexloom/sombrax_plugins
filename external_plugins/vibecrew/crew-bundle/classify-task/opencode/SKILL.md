---
name: classify-task
description: >-
  Routes a VibeCrew card: resolves the main agent first (Claude Code, OpenCode,
  Codex or Pi, decided by the executor), scores the task on five bounded axes
  to a complexity tier (trivial / light / medium / heavy), and maps the tier to
  a pipeline type (Basic / Planned / Async) with per-step agent and model
  defaults, stage toggles (plan-review, code-review, merge vs pr) and the
  one-line `**Routing:**` record for the card. It is the single source of truth
  for the main-agent ladder, the rubric, the tier map, the default binding
  table and the Routing line format. Use when a card is being created or a
  pipeline attached and the operator has not named a pipeline; the
  `product-manager` skill and the `product` agent call it right after drafting
  the spec. Not for composing the `## Pipeline` block, writing specs, or
  creating cards.
---

# classify-task: main agent first, then tier

The user's (or operator's) explicit instructions take precedence over this skill's defaults. Classification only fills in what the operator left unsaid; hard override 1 in Step 2 says how to record a named choice.

This skill turns the task text and the executor context into one explicit,
auditable routing decision at card creation (main agent, pipeline type,
per-step bindings, toggles), recorded on the card. The thresholds come from
measured board telemetry in `reference/routing.md`; a change to a rule here
goes there too, with numbers.

You classify; your caller persists. Return the main agent, tier, pipeline type,
per-step bindings, toggles and Routing line.

## Inputs

- The task text: the best available of the full spec (the `## Task:` render),
  an intake mini-spec, or the raw brief. Run after the spec is drafted.
- The operator's request, verbatim when available. It carries forcing words
  ("quick", "thorough", a named pipeline, a named model).
- Any cheap repo lookups the caller already made. Don't explore code to
  classify: if an axis can't be scored from the text, score it 1 and say so.

## Step 1 — resolve the main agent (before any scoring)

Every card runs on one main agent: the executor its main loop launches with.
Each of the four can also be bound to an individual step.

| Main agent | Executor | Model catalog |
|---|---|---|
| **Claude Code** | `CLAUDE_CODE_HEADED` | Sonnet / Opus / Fable |
| **OpenCode** | `OPENCODE_HEADED` | `zai-coding-plan/glm-5.2`, `minimax/MiniMax-M3`, `kimi-coding/k3` |
| **Pi** *(explicit-ask-only, uncalibrated)* | `PI_HEADED` | same provider-qualified ids as OpenCode |
| **Codex** *(uncalibrated, n=0 — but auto-routable)* | `CODEX_HEADED` | `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` |

- The bundled pipelines (`Basic`, `Planned`, `Async`) carry no executor and no
  model table. Every delegable step inherits the main agent unless it is bound
  to another one, so the main agent seeds the whole card.
- A step may run on a different agent from the main loop. `[agents]` names the
  agent per stage id and `[models]` the model; the runtime renders a one-shot
  on that step's own CLI, run from the main loop. Spec on Claude Code, plan on
  Codex and code on Pi is a legal card.
- A model belongs to the agent of the step it is bound to: `gpt-5.6-sol` on a
  step means Codex, `opus` means Claude Code. If the operator pairs a model
  with an agent that can't run it, report the contradiction instead of
  composing it.
- Codex is the default reviewer: `Planned` and `Async` ship `plan-review` and
  `code-review` bound to `CODEX`. Leave them there unless the operator says
  otherwise; on a Codex main loop they are simply same-agent.
- Pi is explicit-ask-only and uncalibrated. It shares OpenCode's provider
  catalog (GLM / Kimi / MiniMax via the `pi` CLI) but has no telemetry
  (n = 0), is not on the ladder below, and is never auto-routed, as a main
  agent or as a step. Pi is selected only when the operator names a
  `PI`/`PI_HEADED` executor or asks for a step "on pi", and that ask always
  wins.
- Codex is uncalibrated (n = 0) but auto-routable: it is on the ladder and in
  the default binding table, because an operator whose only subscription is
  ChatGPT needs a working route without naming a pipeline on every card. Say
  "Codex main loop, uncalibrated (n=0)" in the report.

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

An agent or model the operator names for one step ("plan on codex", "code on
pi", "review with sonnet") is a per-step binding, not a main-agent signal, so
it does not trigger rung 2. Record it on that stage id and carry it into the
Routing line's `steps:` clause; it overrides the Step 3 default table the same
way a named pipeline overrides the tier map.

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

Measured basis (details in `reference/routing.md`): Basic ships a light card
for ~191K fresh tokens; a full fan-out costs ~507K fresh (the old "ceremony
tax" was a model-price artifact); GLM-5.2 is the most efficient measured
coder; MiniMax-M3 is the weak arm (worst fresh/LOC, and it needed a follow-up
debug card); Fable and the Kimi arm have no completed-card data.

| Tier | Pipeline type | Shape |
|---|---|---|
| **trivial** | **Basic** + executor pin | default state: implement + merge, no delegation |
| **light** | **Planned** | delegated spec → plan → plan review; the main loop writes the code |
| **medium** | **Async** | full fan-out: spec → plan → plan review → code → code review |
| **heavy** | **Async** | + code-review ticked, `pr` instead of `merge` |

- `light → Planned` is a deliberate re-route: a light task used to buy a full
  fan-out on a cheaper coder and now buys delegated planning with main-loop
  coding. It is flagged for recalibration (`reference/routing.md` §7), so
  report "light → Planned (recalibration pending)" until telemetry lands.
- Pipelines come from the app's bundled set plus `~/.vibecrew/pipelines/*.toml`
  (user files shadow bundled ones by `name =`). Check with
  `vibecrew_api.py pipelines` when unsure. Take stage ids and pipeline names
  from that list; removed per-model pipeline names no longer resolve.

### Default per-step bindings

Once the type is chosen, bind the delegable steps. These are defaults
transposed from the per-model pipelines they replaced; anything the operator
says about a step wins.

| Main agent | spec / plan | coder (`code`) | reviews (`plan-review`, `code-review`) |
|---|---|---|---|
| **Claude Code** | `sonnet` (light) · `opus` (medium, heavy) | `sonnet` (light, medium) · `opus` (heavy) | `CODEX` |
| **OpenCode** | `zai-coding-plan/glm-5.2`, effort `high` | `zai-coding-plan/glm-5.2` | `CODEX` |
| **Pi** *(explicit ask only)* | `zai-coding-plan/glm-5.2`, effort `high` | `zai-coding-plan/glm-5.2` | `CODEX` |
| **Codex** *(uncalibrated)* | `gpt-5.6-terra` (light) · `gpt-5.6-sol` (medium, heavy) | `gpt-5.6-terra` (light, medium) · `gpt-5.6-sol` (heavy) | `CODEX` (same agent) |

Sonnet 5.5 as coder: leave effort at its default `high`, the vendor's level for longer agentic coding. Do not pin `low` or `medium` for the code stage: at those levels Sonnet 5.5 is more likely to stop and check in before the work is done, and at `low` it can skip verifying a change.

- OpenCode and Pi model ids are provider-qualified. The bundled pipelines carry
  no `[models] provider`, so a bare `glm-5.2` would pass through unresolved;
  always write `zai-coding-plan/glm-5.2`. The `kimi-coding/k3` and
  `minimax/MiniMax-M3` arms are explicit-ask only (Kimi uncalibrated, MiniMax
  measured-weak), and so is Claude Code's `fable` (n = 0).
- A step with no model binding inherits: on the main loop's agent it takes the
  card's model; on a different agent it takes that CLI's default. Leaving a
  step unbound is fine; bind only what the tier table or the operator calls
  for.
- Reviews stay on Codex unless the operator says otherwise. That is already the
  shipped `[agents]` default of `Planned` and `Async`, so it needs no
  `--stage-agent` flag.
- Effort is TOML-only: no dialog and no compose-endpoint field carries it. Both
  the `high` effort for an OpenCode/Pi spec or plan and the Sonnet 5.5 coder's
  default `high` are recorded in the report (an operator can pin effort in a
  user pipeline's `[effort]` table); neither is passed as a binding.

## Step 4 — stage toggles (independent of tier)

Report every toggle; the caller applies them against the pipeline's
`default_enabled` set when composing the block.

- **spec:** `adopt` when the card description already passes the full-spec
  test (`### Outcome`, `### Scope` and `### Testing & acceptance criteria` each
  at the start of a line, outside any fenced code block, block quote, or
  `<pasted_content id="…">` … `</pasted_content id="…">` block of imported
  GitHub text — the same test the spec stage applies). The spec stage
  detects this itself and copies the description to `SPEC.md` instead of
  spawning a subagent, so nothing is added or dropped; the toggle records the
  expectation so a mis-detect is visible. `write` when the description is not a
  full spec. `skip` only for trivial (Basic has no spec stage). A card created
  by the `product` agent is always a full spec, so always `adopt`.
- **plan-review:** `yes` (forced) when R = 2; otherwise `gate`. With `gate` the
  stage stays listed and the runtime PLAN-GATE decides once the plan exists
  (skip when the plan is under ~40 KB with 0 open decisions). There is no `no`:
  dropping the stage would blind the gate. Basis: plan size ≥ ~40 KB is the
  strongest blowup predictor on the board, and a Codex plan review routinely
  costs more than the plan.
- **code-review:** `yes` (tick the stage) for heavy, and for medium when
  R ≥ 1; otherwise `no`. The runtime caps it at two passes either way.
- **completion:** `merge` (the default; every deployed pipeline ticks it) for
  R ≤ 1; `pr` for heavy or R = 2 (un-tick `merge`, tick `pr`), which puts a
  human gate before landing.
- **coder model:** decided at runtime, not here. The CODER-MODEL check binds it
  after the plan exists and steps up within the bound agent's own catalog
  (Claude Code: sonnet → opus; OpenCode/Pi: MiniMax-M3 → glm-5.2; Codex:
  gpt-5.6-terra → gpt-5.6-sol) when the plan blows its envelope. Record the
  Step 3 default in the Routing line as `coder: post-plan(<agent>/<model>)`,
  naming the agent the `code` step is bound to. `Planned` has no `code` stage:
  its coder is the main loop, so record `coder: main-loop(<main agent>)`.
- **orchestrate:** not yours. The auto-drive opt-in needs the operator's
  explicit ask to execute; routing doesn't change it.

## The Routing line — the durable record

Return exactly one line. The caller places it in the card description directly
above the `## Pipeline` block, outside its delimiters:

```
**Routing:** <tier> → <Basic|Planned|Async> [<main agent>] — S<s> D<d> R<r> N<n> V<v> = <total><; forced by <trigger|operator>>; spec: <adopt|write|skip>; plan-review: <yes|gate>; code-review: <yes|no>; completion: <merge|pr>; coder: post-plan(<agent>/<model>)<; steps: spec=<agent>/<model>, plan=…, plan-review=…, code=…, code-review=…>
```

The bracket names the main agent. Append the `steps:` clause only when at least
one step differs from the main agent (a different agent, or a model the main
loop would not have used). List just those steps, `<agent>/<model>` each, or
`<agent>/-` when only the agent is bound. Omit the clause when every step
inherits.

Examples:

```
**Routing:** medium → Async [OpenCode] — S2 D1 R0 N0 V1 = 4; spec: write; plan-review: gate; code-review: no; completion: merge; coder: post-plan(OpenCode/zai-coding-plan/glm-5.2); steps: plan-review=Codex/-, code-review=Codex/-
```

```
**Routing:** medium → Async [Claude Code] — S2 D1 R1 N1 V1 = 6; spec: write; plan-review: gate; code-review: yes; completion: merge; coder: post-plan(Pi/kimi-coding/k3); steps: plan=Codex/gpt-5.6-sol, plan-review=OpenCode/-, code=Pi/kimi-coding/k3, code-review=Codex/-
```

The second example is a Claude Code main loop with planning on Codex, plan
review on OpenCode and coding on Pi; every one of those bindings is an operator
ask, not a default.

The runtime reads two things from the line: `plan-review: yes` forces the
PLAN-GATE open, and the tier is the plan-size envelope the escalation tripwire
checks. The rest is audit trail for the telemetry feedback loop.

## Escalation is the safety valve

Classify from the text and move on. The planner and coder carry a
`VK-ESCALATE` tripwire (defined in the plugin's `CLAUDE.md`): when grounding
contradicts the tier (an oversized plan, a broken assumption, an unpriced
design decision), they park and the card is re-routed one tier up. A cheap
first route plus that tripwire beats an expensive route taken just in case.

## Worked micro-examples

- *"401 from x.ai when updating thesis — we should use `XAI_API_KEY` env var"*
  → S0 D0 R0 N0 V0 = 0 → trivial → Basic (implement + merge), executor pinned
  to the resolved main agent. (This card once ran a spec stage plus a coder
  subagent: pure overhead.)
- *"Markets page doesn't render content"* → S0 D1 (cause unknown) R0 N0 V0 =
  1, D ≠ 0 → light; Claude Code main agent → Planned [Claude Code], spec/plan
  on `sonnet`, reviews on Codex (the shipped default), spec: write,
  plan-review: gate, coder: main-loop(Claude Code). Flag the light → Planned
  re-route as recalibration pending.
- *"Add Limitless as a fourth venue, cloning the `polymarket/` package; L0
  probe first"* → S2 D1 R0 N0 V1 = 4 → medium → Async [OpenCode] (default
  executor), spec/plan and coder on `zai-coding-plan/glm-5.2`, reviews on
  Codex, spec: adopt (full PM spec already on the card), code-review: no.
- *"Backtest replay engine + depth-aware fill sim + reports/CLI"* → S2 D2 R1
  N2 V2 = 9 → heavy → Async [Claude Code] + code-review, completion: pr,
  spec/plan and coder on `opus` (`fable` only if the operator names it;
  uncalibrated).
- *"Rethink the pipeline architecture — spec on Claude, plan on codex with
  gpt-5.6-sol, plan review on opencode, code on pi"* → the tier still comes
  from the rubric, and every named step is a per-step override. Main agent:
  Claude Code (rung 2 says nothing about the main loop, so the config default
  or the fallback decides); the `steps:` clause carries
  `plan=Codex/gpt-5.6-sol, plan-review=OpenCode/-, code=Pi/-`. Pi is never
  auto-routed and always honored when asked for.

## Report to your caller

- The main agent and the ladder rung that resolved it.
- The tier, all five axis scores and the total, and any override that fired,
  with one-phrase evidence.
- The routed pipeline type and every stage toggle.
- The per-step bindings: agent and model for each delegable stage id, marked
  `default` (Step 3 table), `operator` (an explicit ask) or `inherit`, plus
  every effort note (OpenCode/Pi spec and plan at `high`; a Sonnet 5.5 coder left
  at its default `high`), since effort is TOML-only and can't be passed as a
  binding.
- The Routing line, verbatim.
- Each axis scored 1 for lack of signal, and any contradiction between an
  operator's words and the agent a model belongs to.
