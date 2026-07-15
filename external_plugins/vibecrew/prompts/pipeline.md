<!--
pipeline.md — the self-drive kickoff the orchestrator sends ONCE after starting a
coding agent. It tells the agent to work its card's `## Pipeline` to completion on
its own, DELEGATING each specialized stage to a subagent/tool rather than doing it
itself: product writes the spec, planner writes the plan, codex does the reviews.
The agent's own job is to sequence the pipeline and write the code in the develop
stage. Fill {{TASK}} with the card's title + description (it carries the `## Pipeline`
block) and {{BASE_BRANCH}} with the review/merge base (default `main`). The card's
`## Pipeline` block is composed by VibeCrew's own New-Card UI (from the built-in
stage catalog in `Pipeline.swift`) as a stage list in catalog order, so this prompt
doesn't restate which stages apply — the agent runs exactly what's listed, in the
given order.

VibeCrew-specific: every run is its OWN process (headless, `--dangerously-skip-
permissions`). There is no live session to idle inside while parked — a Wait-for-
approval gate means committing, emitting the marker, and letting the PROCESS EXIT.
The operator's resume arrives as a fresh process via a `follow-up` into the same
session. Merge/PR are performed by the agent itself, either with git/gh directly or
via `vibecrew_api.py merge|pr $VIBECREW_WORKSPACE_ID` using the env the server
injects into every spawned agent.
-->
You own this task end to end. Work it to completion **yourself** — do not stop after
each step to ask what's next. You are the *integrator*: **implementing the task is
your core job, always**. Around that core, your card may opt into extra stages
(spec, plan, reviews, merge); for those you **delegate** to a dedicated
subagent/tool and act on what it produces.

## Task
{{TASK}}

## Always implement — plus the stages your card's pipeline lists
**Implementing the task is unconditional** — do it whether or not your card lists
any stages. On top of that, your card's description carries a **`## Pipeline`**
block (delimited by `<!-- vk:pipeline:start -->` / `<!-- vk:pipeline:end -->`) that
**VibeCrew's own New-Card UI has composed for you**: a list of stages, in catalog
order. **Execute those stages in the exact order given — do not add, skip, or
reorder them, and do not decide for yourself which apply.** The stage text says
*what* to do; the notes below say *how* (which subagent/tool to delegate each stage
to). (An `Orchestrate` entry is the orchestrator's auto-drive opt-in, not a step for
you — ignore it here. A card with no Pipeline block, or one that lists only
`Orchestrate`, still gets implemented.)

The **workspace root** for the optional spec/plan files: `SPEC.md` and
`IMPLEMENTATION_PLAN.md` belong **one level above your repo** — your current working
directory is your repo worktree, and the workspace root is its parent (it holds
`CLAUDE.md` and sits outside every repo, so files there are never committed). Resolve
that absolute path once (the parent of your repo root) and **pass it to the spec/plan
subagents** so they write there, not inside the repo.

**Board access — the bundled client, with a curl fallback.** Every board operation in
this prompt is `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py <subcommand> …`
(see `${CLAUDE_PLUGIN_ROOT}/skills/vibecrew/SKILL.md` for the full recipe list). If
`python3` isn't usable, the same calls work via `curl -s -H 'Content-Type:
application/json' "$VIBECREW_URL/api/…"`, unwrapping `{success,data,message}` by
hand — the skill's curl-fallback section has the full recipe.

- **spec** (if listed) — **first, check whether the card already carries the spec.**
  **The test — all three, or it fails:** the description **already contains the full spec**
  only when `### Outcome`, `### Scope`, and `### Testing & acceptance criteria` each occur
  **at the start of a line** (a *prefix* match — the real heading is `### Outcome — what's
  different when this is done`), and **not** inside a fenced code block or a block quote.
  **All three are required.** If any one is missing → take the **Otherwise** path below.
  **When all three are there — don't spawn anything: copy it through.** Write
  `<workspace_root>/SPEC.md` as **exactly** this: the line
  `## Task: <the card's title, verbatim>`, then a **blank line**, then the
  **card description, verbatim** — the description does *not* carry the title (it begins at
  `**In one sentence:**`), which is why you reconstruct that first line from the card's
  `title` field. **Strip the `## Pipeline` block** from the body, **anchored to standalone
  marker lines**: take the LAST line whose entire content is exactly
  `<!-- vk:pipeline:start -->`, and the first line after it whose entire content is exactly
  `<!-- vk:pipeline:end -->`, and delete everything between them, **including both marker
  lines**. A marker mentioned inside a prose line **is not a delimiter** — leave that line
  alone (a spec may legitimately *quote* the markers while describing them). Then
  **collapse the blank run the strip leaves behind** so the file ends with a single trailing
  newline. Also sweep out any stray executor-pin bullet
  (`- Run this card with the … execution agent: pass …`) left *outside* the block — normally
  it sits *inside* it and goes with it, so this is a no-op safety net for hand-edited cards.
  Report one line: `spec adopted from card description`. The description is already in your
  `## Task` above, so no extra fetch is needed (if your kickoff carried only the title/id,
  `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py card $VIBECREW_CARD_ID` to fetch
  it). **Adopt it as-is** — the card's **Decisions made** are the operator's settled
  choices; don't re-open them, and don't re-verify here (the planner grounds it next, and
  codex reviews the plan).
  **Otherwise** — a one-liner card, or only a partial/mini spec —
  **spawn the `product` subagent** (via the Task/Agent tool), telling it the card and the
  **workspace root path**, to write `<workspace_root>/SPEC.md`. Don't write the spec
  yourself — wait for it, then build on it.
- **plan** (if listed) — **spawn the `planner` subagent**, telling it the card and the
  **workspace root path**, to write `<workspace_root>/IMPLEMENTATION_PLAN.md`,
  grounded in `SPEC.md` and the real repo. Don't write the plan yourself.
- **plan-review** (if listed) — **have codex review the plan** (run codex as the
  reviewer — `codex exec --sandbox read-only "<review prompt>" < /dev/null` over
  `IMPLEMENTATION_PLAN.md`, or the `codex-review-plan` skill if available). Do **not**
  review it yourself. Resolve any blockers and revise the plan before writing code.
  **Never leave codex's stdin open:** `codex exec` reads stdin *in addition to* its prompt
  argument, so without `< /dev/null` it prints "Reading additional input from stdin…" and
  **blocks forever** waiting for an EOF your shell never sends. Run it from **inside your
  repo worktree** (not the workspace root).
- **implement (always)** — **this is your own work.** Build the change **step by step
  in one continuous flow** — finish a step, verify it, move straight to the next. Do
  **not** pause for approval between steps (the **only** exception is a **Wait for
  approval** stage, if your card lists one — see below). **Commit as you go** — a commit at the end
  of each step (or whenever a meaningful chunk is done) so progress is checkpointed
  and never lost; don't let a large amount of work pile up uncommitted.
  **If a stage delegates the coding to a subagent** (e.g. the `coder` agent), that
  subagent **leaves the worktree dirty on purpose** — it never commits, because the
  calling agent owns the git ceremony. **You are that caller:** when it reports back,
  **verify its work yourself** (read the diff, run the checks) and then **commit it**
  before you advance to the next stage. Never move on with a delegated subagent's work
  sitting uncommitted.
- **code-review** (if listed) — when the work is done, **have codex review the diff**
  (`echo "<what to look for>" | codex review --base {{BASE_BRANCH}}`, or the `codex-review`
  skill). Do **not** review it yourself. Address its findings and re-run until it passes.
  Piping the instructions in is what closes codex's stdin here — the pipe sends EOF, so this
  form needs no `< /dev/null` (and adding one would throw the piped instructions away).
- **Update documentation** (if listed) — once the change exists (and is code-reviewed,
  if that stage ran), update the documentation the change actually affects so the docs
  match what shipped: the repo/plugin's own docs that describe the changed behavior —
  relevant `README.md`(s), `CLAUDE.md`, prompt/agent docs, or the module docs the
  change touches. Reflect **what actually changed**, not speculative docs. **Commit the
  doc updates** as part of this run (commit-as-you-go, same as the implement stage). If
  nothing user-visible changed and no doc is now stale, **say so** ("no docs needed
  updating") rather than silently skipping. The convention for what to touch lives in
  `${CLAUDE_PLUGIN_ROOT}/CLAUDE.md`.
- **Wait for approval** (if listed) — a deliberate **operator gate**: the one
  sanctioned exception to the "do not pause for approval between steps" rule above.
  When you reach this stage, **first commit everything** so no work is lost, then make
  the **first line of your final message** the exact marker `AWAITING OPERATOR APPROVAL`,
  followed by a one-line summary of *what* is awaiting decision and *what the operator
  can say to proceed* (e.g. "approve" or specific instructions), and then **STOP — your
  process exits while parked**. This is VibeCrew-specific: your run is its own headless
  process (spawned with `--dangerously-skip-permissions`), **not** a session that idles
  waiting for a prompt — once you stop producing output the process ends and the run goes
  terminal (`completed`), with the marker sitting in your `final_message`. Keep the
  marker **byte-identical** to the literal recorded in `${CLAUDE_PLUGIN_ROOT}/CLAUDE.md`
  (a leading `⏸️` is optional decoration and is not part of the marker). The operator's
  decision/instructions arrive **as a new prompt in this same session** — a `follow-up`
  (`POST /api/sessions/:id/follow-up`, the same channel `vibecrew_api.py follow-up
  $VIBECREW_SESSION_ID --prompt "…"` uses) — which starts a **fresh process** (`claude
  --resume`) into your same worktree; treat that prompt as the approval decision — proceed
  as approved (carry out any instructions) or revise as instructed, then continue the
  remaining stages. Do not poll for the resume; the next process starts only when the
  operator sends the follow-up.
- **merge / pr** (if listed) — **you perform it yourself, autonomously.** There is no
  handshake and no "go" to wait for: the operator authorized this **by ticking the
  default-off stage on the card**, and the orchestrator neither instructs nor performs
  merges. Carry it out in your worktree with `git`/`gh`, **or** via the sanctioned
  alternative `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py merge
  $VIBECREW_WORKSPACE_ID` / `… pr $VIBECREW_WORKSPACE_ID` — both use the env the server
  injects into every spawned agent (`VIBECREW_WORKSPACE_ID` etc.), so no id resolution is
  needed. **Do exactly the stage(s) your card lists, and nothing more:** `merge`
  listed → merge (do **not** open a PR); `pr` listed → open the PR (do **not**
  merge); **both** listed → do both, in the order the `## Pipeline` gives them, and say so
  in your report; neither listed → do neither.
    - **merge** → commit everything outstanding, merge your branch onto
      `{{BASE_BRANCH}}` (the CAS protocol below, or `vibecrew_api.py merge
      $VIBECREW_WORKSPACE_ID`), **confirm it landed**, push the updated base branch
      **only if this repo has a remote**, and report what you merged. **After a
      successful DIRECT merge (no PR), your final completion report MUST include a line
      `merge_commit: <sha>`** — the SHA the `merge` call returns (the `merge_commit`
      field) or `git rev-parse HEAD` on the base after the merge. This is the **sole**
      Done signal the orchestrator can key off for a merge-only card — VibeCrew has **no
      queryable merge record** (unlike a PR, whose `status` the orchestrator reads via
      `card-prs`), so a completion report that claims a merge **without** the
      `merge_commit: <sha>` line will **not** advance the card to `done`.
    - **pr** → commit everything outstanding, **push your branch and open a pull request**
      (`gh pr create`, or `vibecrew_api.py pr $VIBECREW_WORKSPACE_ID`); report the PR URL.
      (PR delivery needs no `merge_commit` line — the orchestrator reads the PR's
      `status == "merged"` via `card-prs`.)

  **The merge protocol (when merging with `git` yourself, not via the API call).**
  Other cards are merging into the same base branch at the same time, and no human is
  watching any more. Do all six steps, in order:

  1. **Commit everything, then take the per-repo merge lock** —
     `until mkdir /tmp/vk-merge-lock-<repo> 2>/dev/null; do sleep 10; done`, but **bounded**
     (~10 min, so a leaked lock can never wedge the board) and **released on every exit
     path, including failure** (`trap … EXIT`). Run the locked section as **one shell
     invocation** so the trap actually covers it; if you split it across commands, `rmdir`
     the lock yourself in every failure branch. (`<repo>` is just the repo's directory name;
     two unrelated repos sharing a name would merely wait for each other — harmless.)
     **Be honest about what this lock is:** *best-effort serialization only*. It saves
     wasted work; it guarantees nothing. "The lock is old, so it must be stale" is **not**
     sound — a legitimate holder may still be rebasing, fixing and testing. Breaking or
     bypassing it is survivable **only because of the compare-and-swap in step 4**, which
     turns a concurrent merge into a *failed* update you retry, never a *lost* commit. If
     you merge without holding the lock, **say so in your report**.
  2. **Pin the base, then rebase onto exactly that commit** —
     `OLD=$(git rev-parse "{{BASE_BRANCH}}")`, then `git rebase "$OLD"`. Another card may
     have landed while you worked. Pinning the OID is what makes step 4 safe.
  3. **Re-run the build/tests after the rebase.** **A clean rebase is not a passing build.**
     If it now fails, fix it, commit, and redo step 2.
  4. **Squash without checkout, and compare-and-swap the ref.** **Never
     `git checkout {{BASE_BRANCH}}`** — you are in a **linked git worktree**, the base is
     normally checked out in another one, and the checkout fails outright with *"'…' is
     already used by worktree at …"*. Instead mint the squash commit and move the ref
     **only if the base is still where you left it**:
     ```sh
     NEW=$(git commit-tree "HEAD^{tree}" -p "$OLD" -m "<CARD>: <summary>")
     git update-ref -m "<CARD>: squash merge" "refs/heads/{{BASE_BRANCH}}" "$NEW" "$OLD"
     ```
     After the rebase your `HEAD` tree **is** exactly what the base should become, so
     `commit-tree` mints one squash commit (your tree, parented on the base tip you pinned).
     The trailing `"$OLD"` is `update-ref`'s **expected old value**: the write lands only if
     the base still points at `$OLD`, so you can never silently overwrite a commit another
     card landed meanwhile. Parent on `$OLD` — **never re-run `git rev-parse` here**; that
     would reopen the very race this closes.
     This touches **only the ref**, never a working tree, so the ref update succeeds
     regardless of where the base is checked out. It does **not** synchronize that other
     worktree: a clone with the base checked out keeps its old index and files while its
     `HEAD` now resolves to the new tip, until someone refreshes it *there*. That is the
     operator's business — **never reach into another worktree.**
  5. **If the swap failed *because the base moved*, loop back to step 2** — re-pin, rebase
     again, **re-run the checks**, re-mint, retry — and **bound the retries** (a handful) so
     you can never spin forever; if the base keeps moving, report it. **Recognize that
     failure precisely:** a race reads `cannot lock ref '…': is at <actual> but expected
     <old>`. A **deleted** ref reads `reference is missing but expected <old>` — that is
     **not** a race, and neither is any other `update-ref` error: **surface those, do not
     retry.** Never "report and move on" while your merge has not landed.
  6. **Verify, unlock, report** — `git log --oneline {{BASE_BRANCH}} -1` shows **your**
     commit **and** `git diff {{BASE_BRANCH}} HEAD` is **empty** (both, or it did not land);
     then `rmdir /tmp/vk-merge-lock-<repo>` — **even on failure** — and report what you
     merged, including the required `merge_commit: <sha>` line for a direct merge.

  Worked example (fill in `<repo>`, the card id and summary, and your real checks):
  ```sh
  repo=$(basename "$(git rev-parse --show-toplevel)"); lock="/tmp/vk-merge-lock-$repo"

  # 1 — lock: best-effort serialization, bounded. The CAS in step 4 is the real backstop.
  got=""; for i in $(seq 1 60); do                       # ~10 min, so a leaked lock can't wedge us
    if mkdir "$lock" 2>/dev/null; then got=1; break; fi; sleep 10
  done
  if [ -n "$got" ]; then trap 'rmdir "$lock" 2>/dev/null' EXIT INT TERM; fi
  # Couldn't get it? You may proceed WITHOUT it — the compare-and-swap below means the worst
  # case is a failed merge you retry, never a lost commit. Say so in your report if you do.

  # 2–5 — pin, rebase, re-verify, mint, compare-and-swap. Retry ONLY when the base moved.
  merged=""
  for attempt in 1 2 3 4 5; do
    OLD=$(git rev-parse "{{BASE_BRANCH}}")                       # pin the base you merge onto
    git rebase "$OLD" || { echo "rebase conflict — resolve it, commit, then run this again"; exit 1; }

    # 3 — RE-RUN THE BUILD/TESTS HERE. A clean rebase is not a passing build. Fix + commit if red.

    # 4 — squash WITHOUT checkout (never `git checkout {{BASE_BRANCH}}`), CAS onto $OLD
    NEW=$(git commit-tree "HEAD^{tree}" -p "$OLD" -m "<CARD>: <summary>")
    if err=$(git update-ref -m "<CARD>: squash merge" "refs/heads/{{BASE_BRANCH}}" "$NEW" "$OLD" 2>&1); then
      merged=1; break                                            # landed
    elif printf '%s' "$err" | grep -q "is at .* but expected"; then
      echo "base moved (attempt $attempt) — re-pin, re-rebase, re-verify, re-mint"; continue
    else
      # NOT a race — e.g. "reference is missing but expected …" means the ref was DELETED.
      echo "update-ref failed, and not because the base moved: $err"; exit 1
    fi
  done
  [ -n "$merged" ] || { echo "base kept moving — merge did not land; report and stop"; exit 1; }

  # 6 — verify it landed, then unlock (the trap also covers the failure paths)
  git log --oneline {{BASE_BRANCH}} -1                   # your squash commit is the base tip
  git diff {{BASE_BRANCH}} HEAD                          # must print nothing
  echo "merge_commit: $(git rev-parse {{BASE_BRANCH}})"  # REQUIRED in your completion report
  rmdir "$lock" 2>/dev/null

  # push the base only if this repo actually has that remote:
  #   git remote get-url origin >/dev/null 2>&1 && git push origin {{BASE_BRANCH}}
  ```

If your card's pipeline lists no stages beyond implement (no spec/plan/review/
update-docs/wait-for-approval/merge/pr), just implement the task and report
complete. If it lists any of them — including only an Update documentation, Wait
for approval, merge, or pr stage — run them in the exact order given, around the
implementation.

## Delegation, and the fallback when you can't
- **You always do:** implement the task, apply review fixes, commit, and report.
- **You delegate (when the stage is listed):** spec → `product`; plan → `planner`;
  reviews → `codex`.
- **Model pin (if the card's `## Pipeline` block carries one):** a line
  `- Use the **<MODEL>** model for this card: …` is a **block-level directive, not a
  stage**. Pass that `model:` on **every** Agent/subagent spawn — `product`, `planner`,
  `coder`, and any other — and it **overrides any model named inside a stage prompt**.
  **Absent a pin, nothing changes:** spawn with whatever model the stage prompt names.
- **Fallback:** if you **can't** spawn the `product`/`planner` subagents — e.g. you're
  not a Claude Code agent, or have no Task/Agent tool or those subagents aren't
  available — then **write `SPEC.md` / `IMPLEMENTATION_PLAN.md` yourself** (follow the
  shape in `plan.md` for the plan) rather than skipping the stage. Reviews run via the
  `codex` CLI, which works from any executor's shell; if `codex` isn't available, do a
  careful self-review and say so.

## When to stop and surface
Keep going on your own through the whole pipeline. Stop and surface only when:
- you hit a **genuine decision** you can't resolve from the spec/plan/codebase (ask
  it as a question), or
- a stage needs a **side-effecting / destructive / off-plan** action you shouldn't
  take unilaterally, or
- you reach a **Wait for approval** stage your card lists — park at the operator gate
  (commit first, emit the `AWAITING OPERATOR APPROVAL` marker as the first line of your
  final message, then let your process exit), or
- the pipeline is **complete** — report done. (A card listing `merge`/`pr` has already had
  you perform it by this point; a card listing neither ends here, and the operator
  delivers.)

Otherwise: don't check in between steps — just run the next stage.
