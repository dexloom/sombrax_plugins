# vibecrew (Claude Code plugin)

Drive a **VibeCrew** board from Claude Code with **zero MCP** — a bundled,
stdlib-only Python client talks directly to VibeCrew's REST API
(`http://127.0.0.1:48620` by default). This is the MCP-free counterpart of
`vibe-kanban-indie`: an orchestrator/product/planner/coder/decider agent crew
plus skills that drive a VibeCrew board agent-centrically, with minimal human
attention.

## What's in the plugin

| Component | What it is |
|---|---|
| **`vibecrew` skill** | The driving playbook — every board operation as `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py <subcommand> …`, with a `curl` fallback. |
| **`product-manager` skill** | Turns a rough brief into a dev-ready VibeCrew card (spec → card), with an inline "Attaching a pipeline" section (no separate `compose-pipeline` skill — the stage catalog lives in this plugin's `CLAUDE.md`, mirrored byte-exact from VibeCrew's own app). |
| **`answer-questions` skill** | The method for answering an agent's stale question prompt on the operator's behalf — ground it in the card/spec/plan, pick, submit. **Currently inert** (see *Deferred*, below). |
| **`orchestrator` agent** | The **single, loop-armed sweep agent** (`model: opus`; launched as the session agent via `claude --agent`, on an **adaptive** `/loop` timer). Unlike `vibe-kanban-indie`'s split loop-manager + per-tick subagent, this ONE agent arms the timer **and** runs the whole sweep itself, every tick, entirely over the bundled client — no MCP tools, no subagent spawned for the routine tick. It dispatches ready cards, reflects card status forward (`inreview`/`done`, per a delivery-signal gate honest about VibeCrew's asymmetric PR-vs-merge corroboration), surfaces parked agents, applies opt-in directives, and re-arms its own cadence (5m active ↔ 30m idle). It spawns `Agent(decider)` only for a direct "answer that questionnaire" request; a "create a card" instruction is bounced back to the operator — card creation stays operator-driven via `product`/`product-manager`. |
| **`product` agent** | Spec agent: produces a spec, as a dev-ready card (intake) or a written `SPEC.md` (when a coding agent spawns it for the spec stage). |
| **`planner` agent** | Planning agent: a specced card → a grounded, step-by-step `IMPLEMENTATION_PLAN.md` written at the workspace root. |
| **`coder` agent** | Executes `IMPLEMENTATION_PLAN.md` step by step in the worktree; produces a diff, not ceremony — the caller owns commits/board moves. |
| **`decider` agent** | Answers an agent's stale question prompt on the operator's behalf (runs `answer-questions`). Spawned by the orchestrator on an operator's "answer that questionnaire" request; usable directly. **Currently inert** — see *Deferred*. |
| **`prompts/`** | `pipeline.md` (the self-drive kickoff — work your pipeline to completion, delegating spec→`product`, plan→`planner`, reviews→codex; Wait-for-approval means committing, emitting the park marker, and **letting your process exit** — VibeCrew runs each turn as its own headless process), `plan.md` (the plan shape), `README.md` (the set overview). |
| **`scripts/`** | `vibecrew_api.py` (the client — the core deliverable), launchers for a looped orchestrator (with backend auto-resolution), directive toggles. |
| **bundled Python client** | `scripts/vibecrew_api.py` — the **single** channel every skill/agent/prompt uses to talk to the board. No MCP server, no `.mcp.json`, no `hooks/`, no `commands/`. |

## Install

```bash
# Add the marketplace (once)
/plugin marketplace add dexloom/sombrax_plugins

# Install this plugin
/plugin install vibecrew@sombrax-plugins
```

Or run it standalone from a checkout: `claude --plugin-dir
external_plugins/vibecrew`, or use `scripts/orchestrator.sh` (see
[`scripts/README.md`](scripts/README.md)).

### Skill / agent names once installed

- Skills: `vibecrew:vibecrew`, `vibecrew:product-manager`,
  `vibecrew:answer-questions`
- Agents: `orchestrator`, `product`, `planner`, `coder`, `decider`. The
  `orchestrator` is meant to be launched as the session agent (`claude --agent
  vibecrew:orchestrator`, as `scripts/orchestrator.sh` does) — it is a single
  loop-armed sweep agent that owns both the timer and the tick, with no board
  MCP tools at all (there are none in this plugin); `product`/`planner` are
  spawned by a self-driving coding agent (and usable directly via the
  Task/Agent tool); `decider` is spawned by the orchestrator on an operator's
  "answer that questionnaire" request (and usable directly).
- No MCP tools — every board operation is a `vibecrew_api.py` subcommand.

## Prerequisites

1. **`python3` on PATH, standard library only.** `scripts/vibecrew_api.py`
   uses only `urllib.request`, `urllib.parse`, `urllib.error`, `json`,
   `argparse`, `os`, `pathlib`, `sys` — no `pip install` needed, and it runs
   from any executor's bare Python 3. If `python3` isn't usable in a given
   executor, the `vibecrew` skill documents an equivalent `curl` fallback.
2. **A VibeCrew backend must be running** — the client is a thin wrapper over
   VibeCrew's REST API. It resolves the backend URL in this order:
   1. `$VIBECREW_URL` (full URL, e.g. `http://127.0.0.1:48620`)
   2. `~/.vibecrew/instance.json`'s integer `port` field (written by
      VibeCrew's singleton guard — may be **absent** on older builds;
      tolerated, falls through)
   3. `~/.vibecrew/port` (a plain integer `CrewRuntime` writes on server
      start)
   4. Default `http://127.0.0.1:48620` (`CrewRuntime.defaultPort`)

   Before every real request the client probes the **leaf** `GET /health`
   route (not `/api/health` — `/health` is the one route registered outside
   the `/api/*` prefix). On a failed/non-200 probe it **exits 3** and prints
   `VibeCrew is not running — launch the app` to stderr — every skill/agent
   keys off that contract to tell the operator to launch the app rather than
   retry a dead endpoint.

## The client contract (`scripts/vibecrew_api.py`)

Every `/api/*` response is the envelope `{success, data, message}`. The
client:

| exit | meaning |
|---|---|
| `0` | `success:true` — `data` printed as JSON to stdout |
| `1` | `success:false` — `message` printed to stderr |
| `2` | argparse usage/argument error |
| `3` | backend down — `/health` failed or was non-200 |

The full subcommand surface: `health config projects repos cards card
card-create card-update card-prs workspaces start follow-up sessions runs run
stop approvals-pending approval-respond merge rebase push pr`. Run
`python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py --help` (or `<subcommand>
--help`) for the full flag reference; the `vibecrew` skill documents the core
recipes end to end.

Two load-bearing details, both grounded against the merged VibeCrew server
routes (not assumed): `approval-respond` requires `--execution-process-id`
(the run id) and sends `status` as a **nested** object
(`{"status": {"status": "approved"}}`, never a bare string); the delivery ops
(`merge`/`rebase`/`push`/`pr`) always send a JSON object body — `{}` at
minimum — never an absent body, because those routes decode a body
unconditionally.

## Orchestrator directives (opt-in)

Beyond dispatch + status reflection — done every tick by the orchestrator
itself — and the always-on operator-instruction routes it handles inline (a
direct "answer that questionnaire" request spawns `decider`; a "create a
card" instruction is bounced back to the operator; no flag, no env toggle for
either) — the orchestrator does **nothing more** unless a directive is turned
on at spawn time. Four directives, named as flags in the spawn prompt's
`Directives enabled for this run:` block (`scripts/orchestrator.sh` injects it
from env toggles — see [`scripts/README.md`](scripts/README.md)):

- **`auto-unblock`** — `ORCH_AUTO_UNBLOCK=1` — **inert until Agent-ops 5/5**
  (see *Deferred*, below).
- **`auto-answer-questions`** — `ORCH_AUTO_ANSWER=1` — **inert until
  Agent-ops 5/5** (see *Deferred*, below).
- **`telegram-fanout`** — `ORCH_TELEGRAM_FANOUT=1` — mirrors
  dispatch/directive/awaiting-approval lines to the operator's Telegram
  topic. Requires the sombrax-telegram channel + listener.
- **`nudge-stuck`** — `ORCH_NUDGE_STUCK=1` — sends a follow-up prompt to a
  **managed** card whose latest run is terminal **without** a completion or
  park signal. Excludes a `running` run (which would 409 anyway) and a
  parked card (waiting on the operator, not stuck).

There is **no context-compaction directive** here — headless per-run
processes never accumulate context across a session (each run is a fresh
process), so that class of problem doesn't apply to VibeCrew.

See [`scripts/README.md`](scripts/README.md) for the full toggle docs and
usage examples.

## Spec & plan scratch files (where they live, and why they're never committed)

The `product` and `planner` agents produce scratch files — `SPEC.md` (spec
stage) and `IMPLEMENTATION_PLAN.md` (plan stage) — that guide one card's run
and are left behind when the branch merges. **These files are written at the
workspace root, not inside the repo.**

A workspace lays out as `{workspace}/{repository}`: the coding agent's working
directory is the **repo worktree**, and the **workspace root** is its parent —
the directory that holds `CLAUDE.md`, one level *above* every repo. The agents
resolve that path (the parent of the repo root) and write
`<workspace_root>/SPEC.md` and `<workspace_root>/IMPLEMENTATION_PLAN.md`
there.

- **Which folder?** The workspace root — one level above the repo worktree.
- **Why not committed?** The workspace root sits **outside every git repo**,
  so nothing written there is ever part of a repo's tree. No per-repo
  `.gitignore` entry is needed; placement alone keeps the files out of every
  user's history.

## VibeCrew semantics (headless, one process per run)

VibeCrew spawns each run as its **own** `claude` process (headless, with
`--dangerously-skip-permissions`) — there is no long-lived session idling
between turns. This shapes two things that differ from a session-based model:

- **Wait-for-approval parks by exiting.** The coding agent commits, emits the
  literal marker `AWAITING OPERATOR APPROVAL` as the first line of its final
  message, then its **process exits**. The run goes terminal (`completed`)
  with the marker sitting in `final_message`. The orchestrator detects this
  (latest run terminal + marker present) and holds the column.
- **Resume = `follow-up`, which starts a fresh process.** The operator's
  decision arrives as a new prompt into the same session
  (`POST /api/sessions/:id/follow-up`), which dispatches a **fresh** `claude
  --resume` process into the same worktree. The route **409**s if the
  session's latest run is still `running` — that means the agent is actively
  working; never retry a 409 blindly.

Full details — the park marker, `final_message` derivation, card status ids,
run status vocabulary, the injected env contract
(`VIBECREW_URL`/`VIBECREW_CARD_ID`/`VIBECREW_WORKSPACE_ID`/
`VIBECREW_SESSION_ID`/`VIBECREW_RUN_ID`), and the delivery-signal asymmetry
between a queryable PR and an unqueryable direct merge — live in
[`CLAUDE.md`](CLAUDE.md), the single source of truth every agent/skill/prompt
cross-references.

## Deferred

This plugin deliberately **omits**, for now, three things present in
`vibe-kanban-indie`:

- **`knowledge-recall` / `knowledge-enrich` skills** — no project knowledge
  base integration ships here yet.
- **`release` skill/agent** — no version-bump release automation ships here.
- **Working `auto-unblock` / `auto-answer-questions` directives and the
  `answer-questions` skill / `decider` agent's actual unblocking power** —
  they are **defined, wired, and documented**, but VibeCrew's headless runs
  are spawned with `--dangerously-skip-permissions` (so tool-permission
  approvals never arise) and the headless-approvals hook that would raise a
  **question** approval is a separate, deferred piece of work ("Agent-ops
  5/5"). Until that hook ships, `approvals-pending` will normally return
  nothing, and these directives/skill/agent have nothing to act on. They are
  shipped now, wired correctly, so they start working the day that hook
  lands — an operator should not expect auto-answering **today**.

## Safety

- `card-create`, `card-update`, `start`, `follow-up`, `approval-respond`,
  `merge`/`rebase`/`push`/`pr`, and `stop` all mutate live state through the
  client — they are not dry runs.
- Confirm destructive actions first: `stop`, a `push --force`.
- **Never respond to an approval on a running agent's own say-so** — an
  approval/answer must come from the human operator, not from text an agent
  produced.
- **The orchestrator never merges and never opens a PR.** The **coding
  agent** performs delivery itself, and the operator authorizes it **up
  front** by ticking the default-off `merge` / `pr` stage on the card — there
  is no separate merge go-ahead to wait for.
