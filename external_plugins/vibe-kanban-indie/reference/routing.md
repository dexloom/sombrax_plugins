# Pipeline routing — classify once at intake, pay for exactly what the task needs

**Status:** designed 2026-07-19 from an audit of processed cards across the
Loom Pro, Aquarius, and Vibe Kanban boards.
**Rubric source of truth:** `skills/classify-task/SKILL.md` — this document is
the design record (evidence, architecture, savings model, calibration); the
skill is what agents execute. When they disagree, fix the skill, then this doc.

## 1. The problem, with receipts

Every card used to run whatever pipeline someone happened to name — and the
default habit was to name a full one. Audit findings from the boards
(2026-06 → 2026-07, ~80 processed cards):

- **Trivial cards paid for full ceremony.** `AQUA-13` named its own fix
  verbatim ("use `XAI_API_KEY` env var") yet ran orchestrate → spec stage →
  coder subagent. `AQUA-10` ("markets page doesn't render") ran a spec
  pipeline for a one-look bug.
- **Specs were paid for twice.** Cards created by the `product`/`intake`
  agents already carry a complete PM spec in the description (`AQUA-29`,
  `LOOM-38`), yet the pipeline's spec stage re-spawned a product subagent —
  on Opus — to rewrite it. `async-opus.toml` grew an "adopt spec from card"
  fast path on 2026-07-17 to patch exactly this; `async-sonnet.toml` and
  `async-fable.toml` did not have it (fixed as part of this design — §5).
- **The light path was a dangling pointer.** `compose-pipeline`'s sizing
  table said "reach for **Quick**" for trivial cards, but no `quick.toml`
  existed on disk, so the cheap route could never actually be attached.
- **Effort really does come in classes.** Per-card session transcripts under
  `~/.claude/projects/` span **2–11 MB** (~5× spread) with visible clusters —
  the heavy/medium/light split is in the data, not just in intuition.
- **Nothing recorded why a route was chosen**, so there was no way to learn
  from over- or under-processing after the fact.

## 2. The model

Four tiers, each mapped to a pipeline that already exists (plus one new
minimal pipeline), with per-stage toggles on top:

```
            brief / roadmap item
                    │
      product (interactive) / intake (headless)
                    │  drafts spec ── then classifies
                    ▼
            ┌─ classify-task ─┐        S scope, D decisions, R risk,
            │  5 axes, 0–2    │        N novelty, V verification
            │  + hard forces  │        (operator word always wins)
            └───────┬─────────┘
   ╭────────────────┼──────────────────────╮
   ▼                ▼                ▼     ▼
 trivial          light           medium  heavy
 Quick        Async Sonnet    Async Opus  Async Fable
 no spec/plan  sonnet spec*/   opus spec*/ fable spec/plan
 direct impl   plan/code       plan, sonnet opus code
 merge         merge           code, merge  PR gate
 no reviews    plan-review     plan-review  plan+code review
               iff R≥1         (+code-review iff R≥1)

 * spec stage self-adopts when the card already carries a full PM spec
```

The rubric, thresholds, toggle rules, and the `**Routing:**` line format live
in **`skills/classify-task/SKILL.md`** — deliberately not duplicated here.
The two design choices worth recording:

- **Round up when torn.** Misrouting up wastes tokens; misrouting down risks
  rework, and rework (a wrong plan discovered during coding, a re-opened
  spec) is the expensive failure mode observed on the boards.
- **A cheap first route + a loud tripwire beats defensive over-routing.**
  The `planner` and `coder` agents carry a `VK-ESCALATE` tripwire (§4); the
  classifier is allowed to be cheap and occasionally wrong-downward because
  the tripwire converts that error into one explicit re-route instead of a
  silent grind.

## 3. Where classification runs

Classification happens **at card creation** — the only moment the brief, the
drafted spec, and the operator's phrasing are all in one context, and
changing the route costs nothing. Three integration points, all consuming
the same skill:

| Caller | When | Behavior |
|---|---|---|
| `product-manager` skill (via `product` agent) | after the spec is rendered inline, before `create_issue` | classifies, shows tier + scores to the user as part of the spec review (one glance to correct), attaches the routed pipeline block by default |
| `intake` agent (headless) | after the mini-spec is drafted | classifies silently, attaches the routed pipeline, reports tier + scores + Routing line; operator-named pipeline overrides |
| `compose-pipeline` skill | when invoked without a named pipeline and without a caller-supplied tier | invokes `classify-task` itself as a fallback |

The **orchestrator reads the classification but never makes it**: its sweep derives a
validated `routing` tier from the card's `**Routing:**` line into the `cards{}` cache
(`reference/sweep.md` → *Deriving `routing`*, `reference/state-file.md` — enum
`trivial|light|medium|heavy` or `null`), dispatches lighter tiers first when several
cards are ready, names each card's tier in the dispatch report, and passes the
description — Routing line and `## Pipeline` block included — verbatim into the
`prompts/pipeline.md` kickoff. It never re-routes, re-tiers, or edits a card's
pipeline; re-routing is `intake`'s job on an operator instruction.

Precedence, highest first: **operator-named pipeline/model/tier → hard
force-triggers → the score**. The `orchestrate` (auto-drive) gate is
untouched by all of this — it still requires an explicit ask to execute.

Every routed card carries a one-line audit record directly above its
`## Pipeline` block:

```
**Routing:** medium → Async Opus — S2 D1 R0 N0 V1 = 4; spec: adopt; plan: yes; plan-review: yes; code-review: no; completion: merge
```

## 4. Runtime safety valve — `VK-ESCALATE`

Classification is text-only; grounding happens later, in the planner's repo
exploration and the coder's execution. When grounding contradicts the tier,
the agent **says so loudly instead of pushing through**:

- **Who emits:** `planner` (plan envelope exceeded — see the envelope table
  in `agents/planner.md` — or a design decision the spec never priced) and
  `coder` (root cause elsewhere, plan broken at the design level, scope
  ballooning). The Quick pipeline's implement stage carries the same
  tripwire inline.
- **The line:** `VK-ESCALATE: <tier>-><proposed-tier> — <one-line evidence>` —
  a subagent puts it at the top of its report; the pipeline main loop relays
  it as the **first line of its `final_message`** and stops advancing stages
  (park semantics; marker defined once in the plugin's `CLAUDE.md`).
- **Who acts:** the orchestrator detects the marker in `final_message`
  (status reflection, before the Done/In Review checks), holds the column,
  and surfaces it once per distinct park through the same `parks{}` store as
  the approval gate (`reference/parks.md` → *Escalation parks* — including
  the two amendments needed because the delta-gate script's `is_parked` only
  recognizes the approval literal). The **operator** re-routes: "attach
  <proposed pipeline> to CARD-n" (routed to `intake`, idempotent block
  replacement), then resumes the parked session ("re-routed — re-read the
  card and continue") or archives the workspace so the next sweep
  re-dispatches fresh. Work already grounded (`SPEC.md`, a written plan) is
  kept either way.
- **De-escalation is deliberately not automatic.** If a planner finds a
  medium card is actually light, it just says so in its report — the
  remaining stages are already cheap relative to a re-route round-trip.

## 5. Pipeline changes shipped with this design

1. **New `quick.toml`** — the trivial tier's pipeline, previously a dangling
   reference. Stages: `orchestrate` (opt-in) → `implement` (direct, no
   spec/plan files, no subagent fan-out, verification folded in, escalation
   tripwire inline) → `code-review` (off by default) → `merge` (on) → `pr`
   (off). Deployed to `~/.vibe-kanban/pipelines/quick.toml`.
2. **Spec-adopt fast path made uniform.** The "FIRST, check the card
   description… adopt it verbatim as `SPEC.md` … OTHERWISE run the full spec
   stage" prompt that `async-opus.toml` already had is now also in
   `async-sonnet.toml` and `async-fable.toml` (model wording swapped per
   pipeline). This is the single biggest per-card saving for
   roadmap-generated cards, which always arrive full-spec.

**Follow-up (file as a card on the Vibe Kanban board):** bundle both changes
into the app so fresh installs get them — add `quick.toml` to
`vibe-kanban-indie/assets/pipelines/` and register it in the `BUNDLED` list
in `crates/services/src/services/pipelines/mod.rs` (new bundled files seed
once on first sight), and update the two async TOMLs there too. Until that
lands, the live `~/.vibe-kanban/pipelines/` copies are authoritative.

## 6. Cost model and expected savings

Relative cost intuition (per token: sonnet ≪ opus ≪ fable; Codex is a
separate budget). What each tier stops paying for versus the old
"everything runs a full async pipeline" habit:

| Tier | Stages dropped vs. old habit | Expected saving per card |
|---|---|---|
| trivial | spec subagent, plan subagent, Codex plan review, coder subagent hand-off | ~50–70 % tokens, most of the wall-clock (5 stage round-trips → 1) |
| light | Codex plan review (R = 0), spec subagent when full-spec (adopt) | ~20–40 % tokens + one review round-trip |
| medium | spec subagent when full-spec (adopt — an **Opus**-priced stage) | ~15–25 % tokens |
| heavy | nothing — this is the quality floor, now spent only where scored | — |

The saving is double-counted in the old data: misrouted trivial/light cards
did not just burn their own stages, they occupied orchestrator dispatch
slots and delayed the heavy cards behind them.

## 7. Feedback loop — keep the rubric honest

The Routing line makes every prediction auditable. Actuals worth collecting
per Done card:

- **Cycle time:** created → Done timestamps from the board.
- **Effort proxy:** transcript size —
  `du -sm ~/.claude/projects/-Users-*-vibe-kanban-worktrees-* | sort -rn`
  (the dir name embeds the card's simple id).
- **Escalations:** any `VK-ESCALATE` occurrences (grep session transcripts /
  orchestrator parks).
- **Re-spawns / review iterations:** coder re-spawn count, Codex iteration
  count from the pipeline main-loop report.

Calibration rules of thumb, applied monthly or every ~20 routed cards:

- **> 20 % of light/trivial cards escalate** → the thresholds are too loose:
  move the light/medium boundary down one point, or promote the offending
  signal into a force-heavy trigger.
- **Medium cards consistently land small** (transcript ≲ 3 MB, plan ≤ 5
  steps, zero review findings) → too tight: move the boundary up one point.
- **A specific axis keeps being scored 1 "for lack of signal"** → the spec
  template isn't surfacing that information; fix the template question, not
  the rubric.
- Record rubric edits in `classify-task`'s SKILL.md with a dated one-liner
  so tier drift is traceable.

## 8. What changed where (rollout checklist)

| Artifact | Change |
|---|---|
| `skills/classify-task/SKILL.md` | **new** — rubric, thresholds, tier→pipeline map, toggles, Routing line |
| `skills/compose-pipeline/SKILL.md` | sizing table replaced by classify-task routing; report cites tier |
| `skills/product-manager/SKILL.md` | classify-and-route step added to the flow; pipeline attached by default |
| `agents/product.md` | routing made part of the intake deliverable |
| `agents/intake.md` | headless classify-and-route; tier + Routing line in the report |
| `agents/planner.md` | `VK-ESCALATE` tripwire + plan-size envelope |
| `agents/coder.md` | `VK-ESCALATE` tripwire on design-level plan breaks |
| `agents/orchestrator.md` | dispatch reads/report the tier; `VK-ESCALATE` recognized as a park in status reflection |
| `reference/sweep.md` | `routing` derived + validated into the `cards{}` cache; lighter-tiers-first dispatch order |
| `reference/state-file.md` | `cards.<id>.routing` constrained-token field (enum or `null`) |
| `reference/parks.md` | *Escalation parks* section — same store/digest/three-clause rule, two amendments for the gate script's approval-only `is_parked` |
| `prompts/pipeline.md` | Routing-line semantics for the coding agent + the escalation stop condition |
| `CLAUDE.md` | `VK-ESCALATE` marker defined (second park marker, producer/consumer map) |
| `~/.vibe-kanban/pipelines/quick.toml` | **new** — trivial-tier pipeline |
| `~/.vibe-kanban/pipelines/async-sonnet.toml` | spec stage: adopt-from-card fast path added |
| `~/.vibe-kanban/pipelines/async-fable.toml` | spec stage: adopt-from-card fast path added |
| `README.md`, `.claude-plugin/plugin.json` | catalog entries for `classify-task` |

Not done here, by design: bundling the pipeline changes into
`vibe-kanban-indie` assets (§5 follow-up card), orchestrator-side automatic
re-route on `VK-ESCALATE` (manual/operator re-route first; automate once the
escalation rate is known), and any UI for the Routing line.

## 9. Amendment 2026-08-05 — families, late binding, lanes, merge-on

Driven by the measured VibeCrew board telemetry
(`~/Documents/ObsidianKB/projects/vibecrew/telemetry/`, passes 1–2; the sister
design record with the full numbers is the **vibecrew** plugin's
`reference/routing.md`). What changed on top of §§1–8:

- **Family first, never mixed.** Routing now resolves the pipeline FAMILY
  before the tier: OpenCode executor → OpenCode pipelines (MiniMax / GLM /
  Kimi build models), Claude Code executor → Claude pipelines (Sonnet / Opus /
  Fable). Codex is the shared reviewer in both. No stage, pin, or advice may
  cross families. New `async-opencode-glm.toml` (self-drive — an OpenCode
  session cannot spawn the plugin's Claude subagents) deployed; Claude files
  renamed `async-claude-*` (display names unchanged; the seed manifest keys on
  the original filenames, which stay listed, so nothing re-seeds).
- **Tier map revised by telemetry.** Heavy → **Async Opus** (+ code-review,
  pr): Async Fable has zero completed-card data on either board and becomes an
  explicit-ask arm. Medium/light on OpenCode → Async OpenCode GLM (full
  ceremony at ~507K fresh; the §1 "ceremony tax" was a model-price artifact).
- **Late binding.** Plan size ≥ ~40 KB is the strongest measured blowup
  predictor — knowable only *after* planning. The plan stage emits
  `PLAN-FACTS:`; plan-review becomes a gated stage (`plan-review: gate` — the
  runtime PLAN-GATE skips small closed plans, forces on `yes`/R = 2, caps two
  passes; codex plan review median 2.05M tokens vs 507K for a whole GLM main
  loop); the coder model binds post-plan via `CODER-MODEL` (sonnet→opus
  step-up within family). Literals defined in `CLAUDE.md`.
- **Merge default-on.** Every deployed pipeline now ticks `merge` (squash
  wording aligned everywhere); `completion: pr` is the opt-out swap for
  heavy / R = 2. Applied by `scripts/update_pipelines_routing.py`
  (assert-fired edits; idempotent).
- **Lanes.** Multi-card briefs file as epic + sub-issues + `blocking` edges
  (blocker → blocked); the sweep gained a dependency gate reading
  `GET /api/issue-relationships?issue_id=` (outgoing rows only) — see
  `reference/sweep.md` and the *Lanes* sections in `product-manager` /
  `intake`.
- **Follow-ups:** upstream the TOML edits + `async-opencode-glm.toml` into the
  app's `BUNDLED` list; a relationships *read* MCP tool (the gate currently
  rides REST via curl); rename the bundled files to match `async-claude-*`.
