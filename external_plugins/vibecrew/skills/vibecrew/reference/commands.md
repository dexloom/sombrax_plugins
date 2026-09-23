# vibecrew command reference

Every command is `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py <subcommand> …`.
Each one probes `GET /health` first and exits 3 when the backend is down (see
`../SKILL.md`). Run `vibecrew_api.py <subcommand> --help` for the full flag list.

## Contents

- [Diagnose the machine (`doctor`)](#diagnose-the-machine)
- [Look at the board (`cards`, `card`, `stages`)](#look-at-the-board)
- [Create or groom a card (`card-create`, `card-update`)](#create-or-groom-a-card)
- [Pipelines (`pipelines`, `pipeline`, `pipeline-put`, `pipeline-compose`)](#pipelines)
- [Lanes (`card-relationships`, `card-relate`, `card-unrelate`)](#lanes)
- [Dispatch a new agent (`start`)](#dispatch-a-new-agent)
- [Resume or steer a parked agent (`follow-up`)](#resume-or-steer-a-parked-agent)
- [Poll a run (`run`)](#poll-a-run)
- [Approvals (`approvals-pending`, `approval-respond`)](#approvals)
- [Reach a headed agent (`send-input`, `pane`)](#reach-a-headed-agent)
- [See who has gone quiet (`agent-activity`)](#see-who-has-gone-quiet)
- [Close a finished workspace (`workspace-update`, `workspace-delete`)](#close-a-finished-workspace)
- [Sweep: bulk-close finished workspaces and their tmux](#sweep)
- [Stop a run (`stop`)](#stop-a-run)
- [Delivery (`merge`, `rebase`, `push`, `pr`, `merge-record`, `pr-record`)](#delivery)
- [GitHub depth (`pr-merge`, `review-ingest`, `github-import`)](#github-depth)
- [curl fallback](#curl-fallback)

## Diagnose the machine

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py doctor --text --failing
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py doctor            # full JSON
```

`GET /api/doctor` is the environment self-diagnosis. It returns one row per
check, each with a `state` and a one-line `hint`: every agent CLI on the
resolved launch PATH (not your terminal's PATH), `tmux`, `gh auth`, the plugin
catalog, the handbook, whether the pipeline TOMLs parse, notification
permission, and the database and worktree sizes.

Run it first when the operator reports a failed launch, an agent that "isn't
installed", a delegated stage that didn't find its subagent, or a filling disk.
It is read-only, never spawns an agent, and answers in a few seconds.

- It exits 0 even when rows are red. Branch on `state` / `summary.healthy`, not
  on the exit code.
- `state` is one of `ok`, `warn`, `fail`, `timed_out`, `skipped`. `timed_out`
  is not a failure: a slow `gh auth status` on a bad network is not a broken
  install, so say that rather than reporting it as broken.
- `id` is stable (`agent.claude`, `tool.tmux`, `content.pipelines`,
  `disk.worktrees`). Quote the specific row to the operator and give its `hint`
  verbatim; the hint is written to be actionable on its own.
- The doctor fixes nothing. Run its hints only when the operator asks.

## Look at the board

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py cards --project-id <id>
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py cards --project-id <id> --status inprogress
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py card <card_id>
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py stages <card_id> --text
```

`cards` returns every card for the project with `description` included, so one
call is enough to classify readiness (the `## Pipeline` Orchestrate opt-in).
`--status` is applied client-side; the route has no status query parameter.

`stages` is for a card whose block is in reference form: numbered stage names,
each with an `` `id:` ``, instead of inlined prompts. It re-renders the ticked
stages through the server's own composer and prints them in the card's order,
so the text matches an inlined block byte for byte. Use it whenever you need
to know what a stage instructs. `--stage <id>` prints one stage; leave out
`--text` for JSON. The `vibecrew-stages` skill wraps the same call with the
fallbacks written out.

## Create or groom a card

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py card-create --project-id <id> --title "<t>" --description-file <f>
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py card-update <card_id> --status inprogress
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py card-update <card_id> --description-file <f>
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py card-update <card_id> --extension-metadata '<json>'
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py card-update <card_id> --extension-metadata-file <f>
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py card-update <card_id> --clear-extension-metadata
```

- Status ids (not display names): `todo`, `inprogress`, `inreview`, `done`,
  `cancelled`. `card-create` defaults to `todo`.
- Use `--description-file` rather than `--description` for a full markdown card
  (for example one carrying a `## Pipeline` block), so it round-trips
  byte-exact.
- `--extension-metadata` takes a JSON object and sends it pre-serialized (the
  store column is JSON text). It replaces the whole blob: if the card already
  carries other keys, fetch it with `card <id>` and merge client-side first.
- `--extension-metadata-file` reads the same JSON from a file (or `-` for
  stdin); use it when the JSON is too quote-heavy for argv.
  `--clear-extension-metadata` writes NULL. The usual source of the JSON is
  `pipeline-compose`.

## Pipelines

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py pipelines
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py pipeline <name>
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py pipeline-put <name> --file <toml>
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py pipeline-compose <name> \
  --enabled-ids spec,plan,plan-review,code,merge \
  --executor CLAUDE_CODE_HEADED [--model <id>] \
  [--stage-agent plan=CODEX] [--stage-model plan=gpt-5.6-sol] [--custom-text "<t>"]
```

Three pipeline types ship bundled (`Basic`, `Planned`, `Async`), plus any user
pipelines. `pipelines` lists them; `pipeline <name>` returns the binding
tables, the resolved `stages[]`, and the raw TOML. The twelve per-model
pipeline names this set replaced return 404 on the API (the app still aliases
them for old cards' labels), so list first rather than guessing a name.

`pipeline-compose` writes nothing. It renders the card's `## Pipeline` block
for a set of ticked stages and per-step bindings and returns
`{block, extension_metadata, steps}`. It runs the same code path as the app's
composer, so a card filed this way is byte-identical to one filed from the UI.

- `--stage-agent` / `--stage-model` are repeatable `STAGE=VALUE` pairs over the
  stages that carry a delegable role. An empty value (`--stage-agent
  plan-review=`) clears the pipeline file's own binding so the stage inherits
  the main loop.
- The two-call flow: `card-create` with the block in the description, then
  `card-update <id> --extension-metadata '<the returned extension_metadata>'`.

## Lanes

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py card-relationships <card_id>
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py card-relate <blocker_id> --related-card-id <blocked_id> --type blocking
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py card-unrelate <card_id> --relationship-id <rel_id>
```

- Direction is blocker → blocked: create the edge on the card that must finish
  first.
- `card-relationships` returns outgoing rows only (`WHERE card_id = ?`). A
  card's own list shows who it blocks, never who blocks it; to find a card's
  blockers, fan out over the other cards.
- Types: `blocking`, `related`, `has_duplicate`. The orchestrator's dependency
  gate holds a `blocking`-targeted card until its blocker is `done` or
  `cancelled`; the app draws these edges as the board's dependency forest.

## Dispatch a new agent

Check first whether the card already has an agent (adopt-before-dispatch):

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py workspaces --card-id <card_id>
```

If a workspace exists, resume it with `follow-up` instead of starting a new
one. Keep one agent per card.

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py start --card-id <id> \
  --prompt-file <filled-pipeline-prompt.md> --executor CLAUDE_CODE \
  [--branch <b>] [--name <n>] [--variant <v>] [--model-id <m>]
```

- Repository scope comes from the card's project at spawn time, so omit
  `--repo-id`. One linked repo spawns the usual flat workspace; several spawn
  one multi-repo workspace (a worktree per repo under one container, all on a
  shared branch). Pass `--repo-id` only when the operator asks to pin a single
  repository: on a multi-repo project it narrows the workspace to that repo
  without saying so.
- `--prompt-file` is the filled `${CLAUDE_PLUGIN_ROOT}/prompts/pipeline.md`
  kickoff (`{{TASK}}` and `{{BASE_BRANCH}}` substituted), written to a temp
  file first.
- Executor resolution order: the card's executor-pin line (see `CLAUDE.md`),
  then `config`'s `executor_profile`, then `CLAUDE_CODE`.
- `--branch` is decoded but not forwarded by the server today (accepted for
  forward compatibility only); don't promise it takes effect.
- Returns 201 `{workspace, session, run}`. Keep `workspace.id`, `session.id`
  and `run.id` for follow-up and polling.

## Resume or steer a parked agent

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py follow-up <session_id> --prompt "approved — merge"
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py follow-up <session_id> --prompt-file <f>
```

A 409 means a run is already `running` for this session: the agent is still
working. Treat it as "still busy" and do not retry blindly. `follow-up` is also
how a Wait-for-approval decision reaches a parked agent. VibeCrew's headless
runs exit their process while parked, so the resume starts a fresh
`claude --resume` process in the same worktree.

## Poll a run

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py run <run_id>
```

Returns `{run: {status, …}, final_message, pending_approvals_count}`.
`run.status` is `running` or terminal (`completed` / `failed` / `killed`).
Parked means the latest run is `completed` and `final_message` contains the
case-sensitive substring `AWAITING OPERATOR APPROVAL` (see `CLAUDE.md`).
`final_message` may be absent until the first assistant message.

## Approvals

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py approvals-pending
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py approvals-pending <run_id>
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py approval-respond <approval_id> \
  --execution-process-id <run_id> --status approved
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py approval-respond <approval_id> \
  --execution-process-id <run_id> --status answered \
  --answers-json '[{"question":"<exact text>","answer":["<label>"]}]'
```

`approval-respond` requires `--execution-process-id` (the run id); the route's
body is non-optional there. `status` is sent as a nested `ApprovalOutcome`
object (`{"status": "approved"}`, `{"status": "denied", "reason": "…"}`,
`{"status": "answered", "answers": […]}`), never a bare string.

Which runs raise approvals:

- OpenCode runs do. Their `permission.asked` / `question.asked` events are
  promoted from the SSE stream into real `approvals` rows (keyed by OpenCode's
  own request id), and responding here unblocks the agent: the decision is
  relayed to `POST /permission/<id>/reply` or `/question/<id>/reply` on that
  session's own server.
- Claude headless runs are spawned with `--dangerously-skip-permissions` and
  raise no tool-permission approvals. Claude question approvals still wait on
  the deferred headless-approvals hook. An empty `approvals-pending` on a
  Claude fleet is expected, not a fault.

## Reach a headed agent

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py send-input <run_id> --text "Why are you stuck"
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py pane <run_id> --lines 40
```

A headed run stays `status: running` for its whole tmux life, so `follow-up`
would 409 forever; `send-input` types into its live TUI instead. Branch on the
status code, not the prose:

| Code | Meaning | What to do |
|---|---|---|
| `409 not_ready_for_input` | mid-turn | retry later |
| `422 not_interactive` | headless run | use `follow-up` |
| `410 session_gone` | the tmux session is gone | stop |
| `404` | no such run | stop |

`pane` shows what the agent's screen shows right now. It is the only way to see
a modal the board's API cannot represent (a trust dialog, or a permission
prompt in a TUI that raises no approval row). A dead session answers `200` with
`alive: false`; that is the answer, not an error.

The canonical nudge payload is exactly `Why are you stuck`: no punctuation, one
literal everywhere, so a transcript grep finds every nudge.

## See who has gone quiet

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py agent-activity
```

A one-shot snapshot of every tracked workspace, each with `last_activity_at`.
A `running` row is not evidence of life: a headed run reads `running` whether
its agent is working, wedged, or sitting on a dialog, so time since last output
is the signal that separates them. The SSE twin is
`GET /api/agent-activity/stream`, for a UI rather than a shell.

## Close a finished workspace

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py workspace-update <workspace_id> --archived true
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py workspace-delete <workspace_id>
```

`workspace-delete` is destructive: it force-removes the worktree, and anything
uncommitted in it is gone with no undo. Delete only when all three hold:

1. the card is `done`;
2. delivery is corroborated (a merged PR from `card-prs`, or a
   `merge_commit: <sha>` line in the run's `final_message`);
3. the latest run is terminal.

Otherwise archive, which is reversible, and say which evidence was missing.

## Sweep

Bulk-close every workspace whose card already shipped, and tear down the headed
tmux sessions that outlived them. This is destructive end to end, so run the
safety check in step 2 before any delete.

A headed run reads `status: running` for its whole tmux life (see
[Reach a headed agent](#reach-a-headed-agent)), so the "latest run is terminal"
rule from [Close a finished workspace](#close-a-finished-workspace) does not
apply to headed workspaces: a done card with its work merged routinely still
shows a `running` run. For the sweep, a headed workspace qualifies when its card
is `done`, its work is merged to the base branch, and it passes the
artifact-only dirty check below. Stop its run and kill its tmux in step 4.

1. Join workspaces to done cards. Gather `done` card ids across every project,
   then keep only workspaces whose `card_id` is in that set:
   ```
   for p in $(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py projects | jq -r .data[].id); do
     python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py cards --project-id "$p" --status done
   done
   python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py workspaces      # join on card_id
   ```
   Skip any workspace whose card is `todo`, `inprogress` or `inreview`, and the
   orchestrator's own pinned workspace.
2. Check each candidate worktree before deleting it:
   ```
   git -C <worktree> status --porcelain
   ```
   A done card is expected to be dirty only with artifacts: untracked
   `.mcp.json`, a modified `Package.resolved` (resolution drift), and pipeline
   paperwork (`SPEC.md`, `IMPLEMENTATION_PLAN.md`, `PRIOR_KNOWLEDGE.md`). If
   anything else is dirty (real source or test changes), the card may not be
   merged: archive it (`workspace-update --archived true`) and flag it instead.
3. Map tmux sessions to cards. A headed run's tmux session is named
   `vc-<lowercased session_uuid>`, where `session_uuid` is the run's
   `executor_action.typ.interactive.session_uuid`. `tmux ls` lists them. A
   session marked `(attached)` is the operator's live terminal; never kill it.
   Kill only sessions whose card is `done`. A session with no matching
   workspace (for example the orchestrator's own attached terminal) is orphaned
   on purpose; leave it.
4. Tear down, in this order:
   ```
   python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py stop <run_id>              # stop a still-running run on a done-card ws
   python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py workspace-delete <workspace_id>   # or: curl -X DELETE "$URL/api/workspaces/<id>"
   tmux kill-session -t "vc-<lowercased-session_uuid>"     # done cards only; preserve attached + non-done
   ```
   Then re-run `workspaces` and `tmux ls` to confirm that only non-done and
   attached sessions remain.

## Stop a run

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py stop <run_id>
```

Kills a running process. Confirm with the operator first.

## Delivery

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py merge <workspace_id> [--repo-id <id>] [--message <m>]
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py rebase <workspace_id> [--repo-id <id>]
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py push <workspace_id> [--repo-id <id>] [--remote <n>] [--force]
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py pr <workspace_id> [--repo-id <id>] [--title <t>] [--body <b>]
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py merge-record <workspace_id> --sha <sha> [--repo-id <id>] [--target <b>] [--message <m>]
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py pr-record <workspace_id> --number <n> --url <u> [--status <s>] [--repo-id <id>] [--title <t>]
```

- The coding agent usually calls these itself with `$VIBECREW_WORKSPACE_ID`
  (injected env). The orchestrator never merges or opens PRs (see `CLAUDE.md`'s
  delivery-signal gate).
- `rebase` may return a 409 with `success:true`. That is a data-bearing
  conflict outcome, not an error; the client treats it as data and exits 0.
- `merge-record` and `pr-record` are recording calls: they perform nothing and
  are idempotent (keyed workspace/repo/sha and workspace/repo/number). The
  coding agent calls them right after a git direct merge or a `gh`-opened PR to
  leave durable delivery evidence. The `merge_commit: <sha>` completion-report
  line is still required either way.

## GitHub depth

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py pr-merge <workspace_id> [--repo-id <id>] [--number <n>] [--method squash|merge|rebase] [--delete-branch]
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py review-ingest <workspace_id>
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py github-import <project_id> [--repo owner/name] [--state open|closed|all] [--limit <n>] [--status <col>]
```

All three need GitHub auth: `gh auth login`, or a `GH_TOKEN` / `GITHUB_TOKEN` /
config `github.token`. Without it they fail visibly with GitHub's own reason (a
502 from the route, plus a row on the failures feed). `doctor`'s `tool.gh` row
is the precondition check.

- `pr-merge` merges the workspace's PR on GitHub. It is the selectable
  alternative to `merge`, which stays the default and merges locally. It
  records the resulting sha in `merges` the same way `merge-record` does, so a
  `SHIPPING-REPORT:` block reads the same `merge_commit:` either way, and it
  flips the PR row to `merged` so the board and GitHub stay in step. It is
  idempotent: re-merging an already-merged PR re-reads the sha.
- `review-ingest` pulls the workspace's PR review comments onto its card now,
  instead of waiting for the background poll. Ingested comments carry
  `author_kind: github` and `author_label: <the GitHub login>`, so a human's
  review is distinguishable from an agent's note, and a fresh batch is
  delivered to the workspace's agent as a follow-up. `ingested` counts only
  what the card did not already have; a second call returns `0`.
- `github-import` is a one-shot Issues → cards import (there is no continuous
  sync). One card per issue. Every label becomes a tag verbatim, matched
  case-insensitively against the board's existing tags; nothing is dropped. It
  is re-runnable: issues already imported come back in `skipped`, never as a
  second card.

## curl fallback

If `python3` isn't usable, the same board calls work through `curl`. Resolve
the base URL the way the client does (simplest: `~/.vibecrew/port`, or
`$VIBECREW_URL` when it is exported) and unwrap `{success, data, message}` by
hand:

```sh
# base URL (or use $VIBECREW_URL if already exported)
URL="http://127.0.0.1:$(cat ~/.vibecrew/port 2>/dev/null || echo 48620)"

# a worked GET — list projects
curl -s "$URL/api/projects" | python3 -c \
  'import json,sys; e=json.load(sys.stdin); print(json.dumps(e["data"], indent=2)) if e["success"] else sys.exit(e.get("message"))'

# a worked POST — respond to an approval (nested ApprovalOutcome body)
curl -s -X POST "$URL/api/approvals/<approval_id>/respond" \
  -H 'Content-Type: application/json' \
  -d '{"execution_process_id":"<run_id>","status":{"status":"approved"}}'
```

The health probe is the leaf `GET $URL/health` (not `/api/health`). A non-200
or unreachable response means the backend is down.
