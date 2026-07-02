---
name: release
description: >-
  The self-discovering method for cutting a version-bump release of the
  vibe-kanban repo, run as an ordinary vibe-kanban card instead of a bespoke
  script. Reads the release-version anchor from `npx-cli/package.json`,
  discovers every version location by glob (no hardcoded file counts — the
  release topology has drifted before and will again), and runs one of two
  modes: a read-only **verify/dry-run** that reports every location in a
  table and writes nothing, or a **bump** checklist that moves every in-set
  location from anchor to target, refreshes every `Cargo.lock` bump-only,
  promotes the CHANGELOG's `[Unreleased]` section, runs a bump-only diff gate
  (the guard against the v0.2.9 clobber / restore commit cbbdffcc, VIBE-38),
  commits once, and tags `v<target>` to match `npx-cli/package.json` so
  `release-indie.yml` fires on push. Use this skill WHENEVER a vibe-kanban
  release needs cutting or checking — "cut a release", "bump the version to
  X.Y.Z", "release vX.Y.Z", "verify release versions", "dry-run the release",
  "check the release is consistent". It operates on the vibe-kanban worktree
  the card runs in. Publishing beyond the tag (npm publish, GitHub release
  assets) is `release-indie.yml`'s job, not this skill's — this skill's job
  ends at a correct local commit + tag.
---

# release — cut a vibe-kanban version bump, self-discovering

## What this skill is / when

Cutting a vibe-kanban release means moving a version number across a handful
of files that are scattered around the repo — some npm `package.json`s, the
Rust workspace root, a couple of explicit-version crates, and every
`Cargo.lock` that records those crates' versions — then promoting the
changelog and tagging. Doing this by hand (or with a bespoke one-off script
that hardcodes "these N files") is exactly how it goes wrong: a stale count
misses a file, or a script rewrites more than the version and clobbers
unrelated local work. That happened once already — the v0.2.9 release
sweep clobbered unrelated changes and had to be restored in commit
`cbbdffcc` (tracked as VIBE-38). This skill exists so a release runs as an
ordinary, reviewable vibe-kanban card: it **discovers** the version
locations instead of trusting a remembered count, and it **refuses to
commit** unless the resulting diff is provably bump-only.

This skill operates on the **vibe-kanban repo worktree** the card is running
in (i.e. the repo the card's workspace checked out) — not on this plugin's
own repo, and it never touches this plugin's own `.claude-plugin/plugin.json`
version.

## Inputs

- **Target version `X.Y.Z`** — read from the card title/description/prompt
  that invoked this skill (e.g. "bump the version to 0.2.11", "release
  v0.3.0"). If no target version is present anywhere in what you were given,
  you have no bump target — fall back to **verify/dry-run mode**.
- **Mode** — **verify/dry-run** (the default: no target given, or the
  request explicitly asks to check/verify/dry-run) vs. **bump** (a target
  version was given and the request asks to cut/release/bump).

## The anchor rule — the discovery principle

Read the **current** release version from `npx-cli/package.json`
(`.version`) — call it the **anchor**. This file is the tag-authoritative
one: `release-indie.yml` triggers on `push: tags: ["v*"]` and its header
requires the tag equal `v<npx-cli's version>`.

A version location is **in the release set** if and only if its current
version **equals the anchor**. The method:

1. Discovers candidate locations by **glob**, not by a remembered list.
2. Classifies each as in-set (== anchor) or independent (!= anchor).
3. Moves only in-set locations, anchor → target.
4. Leaves independent locations (e.g. a package that versions itself
   separately) completely alone.

This is what makes the method survive the repo growing or shrinking a
package or crate: add a crate, remove one, split a package — the glob picks
it up and the anchor comparison classifies it correctly, with no hardcoded
count to go stale. Do not write "N package.json files" or "N crates"
anywhere in your reasoning or report; discover the actual count every run.

## Verify / dry-run mode (read-only — writes nothing)

Run this first in bump mode too (it's the bump preflight), or standalone
when asked to check/verify.

1. **Read the anchor** — `npx-cli/package.json` → `.version`.
2. **Discover and read every version location:**
   - Every `package.json` in the repo, via a glob that **excludes**
     `node_modules` and `dist` (and any other build-output dir) — read each
     one's `.version`.
   - The root `Cargo.toml`'s `[workspace.package]` → `version`.
   - Every crate manifest via a **recursive** glob — `crates/**/Cargo.toml`,
     not `crates/*/Cargo.toml` — so nested crates aren't missed. For each,
     record whether its `[package]` section carries an **explicit**
     `version = "..."` or inherits via `version.workspace = true`.
   - Every `Cargo.lock` via glob (root and any per-crate locks e.g. under
     `crates/*/`) — read the workspace-member `version = ` lines each one
     records.
   - The **derived** `__APP_VERSION__` — it is not a literal to grep for; it
     is injected by `packages/local-web/vite.config.ts` (and similarly
     `packages/remote-web/vite.config.ts`) as
     `JSON.stringify(pkg.version)` from that package's own `package.json`.
     So the local-web app's `__APP_VERSION__` == `packages/local-web/package.json`
     version. Note remote-web's separately — it is independently versioned
     and its `__APP_VERSION__` tracks its own package, not the release.
3. **Report a table**: `location → version → in-set (==anchor) / independent
   → agrees with anchor?`. List every in-set location explicitly — the
   anchor rule moves *anything* that currently equals the anchor, so an
   independently-versioned file that merely happens to coincide with the
   anchor version needs to be visible in this table before anyone bumps,
   not discovered after the fact. Also report the tag that a bump would
   push: `v<anchor>` (or, if a target was given, note the tag the bump would
   create: `v<target>`).
4. **Write nothing, commit nothing, tag nothing.** This mode is safe to run
   any time as a pre-flight, and is conceptually what a CI consistency check
   would run.

If any in-set locations disagree with each other (drift already exists
before you've touched anything), say so plainly in the report — bump mode
must not proceed on top of existing drift (see Bump step 1).

## Bump mode (checklist)

Only run this with a target version in hand. Work the steps in order; each
one gates the next.

0. **Clean-worktree + tag-not-exist preflight (hard blocker).**
   - `git status --porcelain` must be **empty**. Abort if it isn't — a dirty
     worktree risks sweeping unrelated local changes into the release
     commit, which is exactly the cbbdffcc/VIBE-38 failure mode. Report what
     is dirty and stop; do not stash or discard anything yourself.
   - The target tag must not already exist:
     `git rev-parse -q --verify refs/tags/v<target>` must fail. Abort with a
     clear message if it already exists.
1. **Run verify/dry-run mode** (above) as the real pre-flight. Abort if
   in-set locations disagree with each other — fix or investigate the drift
   before bumping on top of it.
2. **Bump npm.** For every in-set `package.json` (anchor == current
   version) — this always includes root `package.json`, `npx-cli/package.json`,
   and `packages/local-web/package.json`, and any other file the discovery
   pass found at the anchor version — set `.version` to the target. Leave
   every independent package.json (anything not at the anchor) untouched.
3. **Bump Rust.**
   - Set root `Cargo.toml`'s `[workspace.package].version` from anchor to
     target. Every crate that inherits via `version.workspace = true` moves
     automatically with this one edit — do not hand-edit those crates.
   - For every crate manifest discovered with an **explicit** version equal
     to the anchor (currently `crates/relay-tunnel/Cargo.toml` and
     `crates/remote/Cargo.toml`, but re-derive this from the discovery pass,
     not from memory), set its `[package].version` to the target.
   - **Edit ONLY a `[workspace.package].version` or a crate's own
     `[package].version` field.** Never touch a dependency's
     `version = "..."` line (e.g. under `[dependencies]` /
     `[dependencies.foo]`) — that is a dependency pin, not a release
     version, and editing it is scope creep this method must never do.
4. **Refresh every `Cargo.lock` bump-only.** After the manifest edits above,
   for each lock file's directory (the workspace root, and each crate that
   has its own standalone lock, e.g. `crates/relay-tunnel/`,
   `crates/remote/`) run **`cargo metadata --offline`** (or
   `cargo check --offline` if metadata alone doesn't rewrite the lock) in
   that directory. This rewrites the workspace-member `version = ` lines in
   the lock to match the manifests, without touching the network.
   - **Do NOT run `cargo update --workspace` (offline or not).** A
     workspace-wide update can still shift dependency-graph entries even
     offline (cached registry index drift) — it is not bump-only by
     construction.
   - If a `cargo metadata --offline` / `cargo check --offline` run does not
     actually update a lock's member version lines, **STOP and report** —
     do not reach for a broader update to force it.
   - A targeted `cargo update -p <member> --precise <target>` is a last
     resort for a lock that genuinely won't refresh any other way, and is
     only acceptable if the resulting diff for that lock still passes the
     bump-only gate in step 7 (member version lines only, no dependency-graph
     churn).
5. **Promote the changelog.** In `CHANGELOG.md` (Keep-a-Changelog format),
   insert a new `## [X.Y.Z] - <today's date>` section directly below
   `## [Unreleased]`, **moving** the existing `[Unreleased]` subsections
   (`### Added` / `### Changed` / etc.) and their entries into the new
   section. Leave `## [Unreleased]` present but empty, ready for the next
   cycle. **Do not author new changelog prose** — only relocate what is
   already there under `[Unreleased]`.
6. **`__APP_VERSION__` sync check.** Confirm
   `packages/local-web/package.json`'s version now equals the target (it
   will, from step 2) — this is the whole check, since `__APP_VERSION__` is
   derived at build time from that file, not a literal anywhere to edit.
   Note remote-web's `package.json` is untouched and intentionally
   independent.
7. **Bump-only verification gate — the crux of this method.** Run
   `git diff --stat` and `git diff`. The diff must touch **only**:
   - the in-set `package.json` files (a single changed `"version"` line
     each),
   - root `Cargo.toml` (`[workspace.package].version`),
   - the explicit-version crate `Cargo.toml`s (their `[package].version`),
   - every refreshed `Cargo.lock` (workspace-member `version = ` lines
     only — no added/removed/reordered dependency entries),
   - `CHANGELOG.md` (the promoted section move).

   **If any other file appears in the diff, or any hunk in an expected
   file is not a version-line change, STOP and report — do not commit.**
   This is the cbbdffcc/VIBE-38 clobber signature: an edit that reached
   beyond version fields. Name it explicitly in your report if you catch
   it. Specifically double-check each `Cargo.lock` diff is version-line-only
   for workspace members, with zero dependency-graph churn.
8. **Commit.** One clean, bump-only commit once the gate passes — e.g.
   `release: v<target>`.
9. **Tag.** `git tag v<target>`, where `<target>` matches
   `npx-cli/package.json`'s new version exactly, so the tag is what
   `release-indie.yml` expects (`push: tags: ["v*"]`, tag == `v<npm
   version>`). **Do not push the tag** — pushing it is the trigger for the
   release workflow, and this skill's job ends at a correct local
   commit + tag. State plainly in your report that pushing `v<target>` is
   the next action (for the operator or a follow-up card) to actually fire
   the release.

## Guardrails / done-when

- Verify/dry-run mode never writes, commits, or tags anything — it is safe
  to run at any time, repeatedly.
- Bump mode only proceeds past a clean worktree and a non-existent target
  tag.
- No dependency `version = "..."` field is ever touched — only
  `[workspace.package].version` and a crate's own `[package].version`.
- Every `Cargo.lock` discovered by glob is refreshed bump-only via
  `cargo metadata --offline` / `cargo check --offline` per lock directory —
  never `cargo update --workspace`.
- The changelog promotion only moves existing `[Unreleased]` content; it
  never invents notes.
- The final diff passes the bump-only gate before any commit — this is the
  non-negotiable guard against a repeat of the v0.2.9 / cbbdffcc / VIBE-38
  clobber.
- The tag is `v<target>` and `<target>` equals `npx-cli/package.json`'s new
  version, matching what `release-indie.yml` expects.
- Nothing is hardcoded as a file count anywhere in this method — every
  location list above is produced by glob + the anchor comparison at run
  time, so it self-corrects as crates/packages are added or removed.

## Cross-reference

The **anchor rule** (read `npx-cli/package.json` as the anchor; in-set iff
== anchor; discover by glob, not by list) is what makes this method
self-discovering — it is stated once above and every other section refers
back to it rather than repeating a location list. Publishing beyond the
tag — `npm publish`, GitHub release notes/assets — is `release-indie.yml`'s
job once the tag is pushed; this skill does not run or replace that
workflow.
