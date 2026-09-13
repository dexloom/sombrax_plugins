---
name: disk-cleanup
description: >-
  Inspect macOS disk space with focus on Time Machine local snapshots, decide
  whether active VibeCrew workspaces are captured in those snapshots, and
  reclaim space from the snapshots when they are occupying disk. Use this
  skill whenever the operator or the orchestrator (over the inter-agent
  protocol)   asks to check free disk space, reports the disk is low/full,
  wonders where space went, or asks about Time Machine snapshot bloat —
  macOS Time Machine records hourly LOCAL snapshots and keeps them for hours
  (up to 24, thinning under space pressure), so active workspaces constantly
  churn into snapshots and consume real space. Also
  use it after any "no space left on device" build failure. Snapshot
  thinning never touches live files — it is the safest large reclaim on the
  machine.
---

# Disk cleanup — Time Machine snapshots first

Free-space problems on a dev machine with active agent workspaces are usually
three-layered: (1) Time Machine LOCAL snapshots pinning deleted/changed data,
(2) regenerable build artifacts, (3) package-manager caches. This skill leads
with (1) because it is invisible in `du`, it is where workspace churn
accumulates, and reclaiming it is safe by construction — thinning a snapshot
cannot lose a live file.

Work through the phases in order. Measure, decide, reclaim, verify, report.

## Phase 1 — Measure

```bash
df -h /                                      # free space BEFORE (the number everyone asks about)
tmutil listlocalsnapshots /                  # every local snapshot, newest last (com.apple.TimeMachine.2026-09-13-041326)
tmutil listlocalsnapshotdates /              # just the dates, easiest to eyeball for age/count
diskutil apfs listSnapshots /                # per-snapshot XID + punctuation (volume must be apfs)
```

Notes that matter:

- Local snapshots (`tmutil listlocalsnapshots`) are DIFFERENT from the backup
  destination (`tmutil destinationinfo` — a separate disk; not the local-space
  problem). Do not conflate them in the report.
- `df`'s "available" already excludes purgeable space macOS could reclaim;
  the snapshot list is the inventory of what thinning can release.
- macOS automatically thins local snapshots under pressure and ages them out;
  the question this skill answers is whether WORKSPACE churn is parked in
  them NOW, and whether to force it.

## Phase 2 — Are workspaces captured?

Snapshots are volume-wide; a snapshot holds space only for data that changed
or vanished after it was taken. So "workspaces are captured" ≈ "workspace
data churned since the oldest retained snapshot":

```bash
ROOT="${VIBECREW_WORKSPACES_ROOT:-$HOME/.vibecrew/worktrees}"
OLDEST=$(tmutil listlocalsnapshotdates / | tail -1)   # e.g. 2026-09-12-101010
du -sh "$ROOT" 2>/dev/null                             # live workspace footprint
find "$ROOT" -newerct "$(echo $OLDEST | cut -d. -f2 | sed 's/\(....\)\(..\)\(..\)-\(..\)\(..\)\(..\)/\1-\2-\3 \4:\5:\6/')" -type f 2>/dev/null | wc -l
```

The `find -newerct` count = files in workspaces modified since the oldest
snapshot; every one of them (and anything deleted under `$ROOT` since) has
extent data pinned by at least one snapshot. A high count with many snapshots
means workspace churn IS occupying snapshot space.

Simplify when the sed is unwieldy: use the newest snapshot date from
`listlocalsnapshotdates` output and GNU-style quoting, or compare
`stat -f %m` against `date -j -f` parsing — the goal is a boolean plus a
magnitude, not exact bytes (APFS exposes no per-snapshot size).

## Phase 3 — Reclaim (snapshot thinning — safe by construction)

Never `rm` anything under `/System/Volumes/`, never touch the backup
destination, never delete live workspace files in this phase.

```bash
# Ask for exactly what you need, with urgency 4 (highest; use when disk-low is blocking work):
sudo tmutil thinlocalsnapshots / $(num-gigabytes * 1000000000) 4
#   e.g. to target ~40 GB: sudo tmutil thinlocalsnapshots / 40000000000 4

# Or delete ONE specific local snapshot by date (from listlocalsnapshotdates):
sudo tmutil deletelocalsnapshots 2026-09-13-041326
```

- `thinlocalsnapshots` deletes the OLDEST snapshots first until the purge
  amount is satisfied (or snapshots run out); it reports what it freed.
- Some macOS builds run `tmutil` without sudo for local snapshots; try
  without first, use sudo when refused, and say so in the report.
- Re-run `df -h /` after — the honest delta, not the requested amount, is the
  result. (If free space barely moved, the space was not in snapshots —
  continue to build artifacts/caches with the operator's generic
  disk-cleanup tooling, and say that's what happened.)

If workspaces will keep churning and the operator wants snapshots to stop
capturing them, RECOMMEND (do not silently apply — it changes backup
behavior for those paths):

```bash
sudo tmutil addexclusion -p "$ROOT"
```

## Phase 4 — Report

Lead with the pair everyone cares about, then the decomposition:

```
Free space: 12.1 GB → 51.7 GB (reclaimed 39.6 GB)
Local snapshots: 7 → 2 (thinned 5, oldest first: 2026-09-12-101010 … 2026-09-13-021010)
Workspace capture: ~18k files under $VIBECREW_WORKSPACES_ROOT modified since the oldest
  snapshot — that churn was what the thinned snapshots held.
Kept: 2 newest snapshots (macOS ages them out on its own within hours).
Recommend, not applied: tmutil addexclusion -p <workspaces root> to keep future
  snapshots from capturing workspace churn (trade-off: those paths lose
  snapshot-based recovery).
```

When answering a request that arrived over the inter-agent protocol, put the
before/after free-space pair and the reclaimed amount in the FIRST lines of
the reply — the requester is an orchestrator keeping a tick report, not a
human reading prose.

## Guardrails

- Snapshot deletion is the SAFE direction; if the operator asks for riskier
  reclaims (build artifacts, caches, trash), those are separate decisions
  with their own confirmations — never bundle them into a thinning pass.
- Never exclude a path from backups without flagging the trade-off.
- If `tmutil` reports no local snapshots and free space is still low, say so
  plainly — the space is elsewhere (build artifacts, caches, large files) and
  guessing helps no one.
