#!/usr/bin/env python3
"""ship_planner.py — build a ship plan (lanes x waves) for a vibe-kanban board.

Invoked by the orchestrator when the operator wants to SHIP a set of cards: it
reads the board, derives the dependency tree split into LANES (parallel — one
per root parent) and WAVES (sequential — topological levels of the `blocking`
graph), and emits a JSON plan whose `next` list is exactly the cards the
orchestrator may dispatch right now. The orchestrator re-runs the planner each
sweep: a shipped card reaches a terminal column, freeing the next wave.

Lanes and waves are derived exactly as the operator chose:

  - LANE  = the set of cards sharing a root parent (walk `parent_issue_id` up).
            A standalone card (no parent) is its own singleton lane. No edge
            between lanes IS the parallelism — distinct lanes dispatch together.
  - WAVE  = topological level of the `blocking` edges (blocker -> blocked) within
            the lane graph. Wave 0 = nothing unshipped blocks it; wave N = all of
            its blockers sit in waves < N. A card already in a terminal column is
            satisfied and drops out, the same way the sweep's dependency gate
            treats it.

Pure planner (no network): `plan --input snapshot.json`. Live mode resolves the
backend exactly like `scripts/resolve-backend.sh` and fetches only the routes
the plugin already documents as REST (`/api/health`, `/api/projects`,
`/api/project-statuses`, `/api/issue-relationships`). The issue LIST is
MCP-gated (`list_issues`), so live mode also probes `/api/issues?project_id=`;
if that route is absent on the backend, it fails fast with a pointer to
`--input` rather than guessing.

Stdlib only (urllib + json + argparse), like every other script in this dir.
Exit codes: 0 ok, 1 logical failure, 2 argparse, 3 backend down.

Usage:
    python3 ship_planner.py plan --input snapshot.json [--cards VIBE-1,VIBE-2]
    python3 ship_planner.py plan --project <id> [--cards ...] [--wip-cap 5] [--pretty]
    python3 ship_planner.py plan --project <id> --input snapshot.json   # statuses/edges live, issues from file
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

HEALTH_PATH = "/api/health"
RELATIONSHIP_CAP = 50  # mirror the sweep's dependency-gate fan-out bound
DEFAULT_WIP_CAP = 5

TIER_RANK = {"trivial": 0, "light": 1, "medium": 2, "heavy": 3}
ROUTING_RE = re.compile(r"\*\*Routing:\*\*\s*([A-Za-z]+)")

DOWN_MESSAGE = "vibe-kanban backend is not running — launch the app"


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------

class BackendError(Exception):
    """Backend unreachable or returned an unparseable response."""


class LiveFetchUnsupported(Exception):
    """A live REST route the backend does not expose — point the user at --input."""


# --------------------------------------------------------------------------
# Base-URL resolution (mirrors scripts/resolve-backend.sh)
# --------------------------------------------------------------------------

def _candidate_port_files():
    cands = []
    tmpdir = os.environ.get("TMPDIR")
    if tmpdir:
        cands.append(Path(tmpdir.rstrip("/")) / "vibe-kanban" / "vibe-kanban.port")
    try:
        import subprocess
        darwin_tmp = subprocess.check_output(
            ["getconf", "DARWIN_USER_TEMP_DIR"], text=True
        ).strip()
        if darwin_tmp:
            cands.append(Path(darwin_tmp.rstrip("/")) / "vibe-kanban" / "vibe-kanban.port")
    except Exception:
        pass
    cands.append(Path("/tmp/vibe-kanban/vibe-kanban.port"))
    return cands


def resolve_base_url():
    """Resolution order: $VIBE_BACKEND_URL -> port file (alive first, freshest
    fallback) -> None (caller decides). Returns a URL string or None."""
    env_url = os.environ.get("VIBE_BACKEND_URL")
    if env_url:
        return env_url.rstrip("/")

    alive_url = None
    fallback_url = None
    fallback_mtime = 0
    for f in _candidate_port_files():
        if not f.is_file():
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except OSError:
            continue
        m = re.search(r'"main_port"\s*:\s*([0-9]+)', text)
        if not m:
            continue
        url = f"http://127.0.0.1:{m.group(1)}"
        try:
            mtime = f.stat().st_mtime
        except OSError:
            mtime = 0
        if mtime >= fallback_mtime:
            fallback_mtime, fallback_url = mtime, url
        if alive_url is None and _probe_ok(url, silent=True):
            alive_url = url

    return alive_url or fallback_url


def _probe_ok(base, silent=False):
    url = base + HEALTH_PATH
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=3) as resp:
            return resp.getcode() == 200
    except Exception:
        return False


def require_backend(override=None):
    """Resolve (--backend wins) + health-check; exit 3 with the canonical
    message if the backend is down."""
    base = override or resolve_base_url()
    if base and _probe_ok(base):
        return base
    print(DOWN_MESSAGE, file=sys.stderr)
    sys.exit(3)


# --------------------------------------------------------------------------
# HTTP + envelope handling
# --------------------------------------------------------------------------

def http_get_json(base, path, query=None, timeout=15):
    url = base + path
    if query:
        qs = urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        if qs:
            url = f"{url}?{qs}"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.getcode()
            body = resp.read()
    except urllib.error.HTTPError as e:
        # 404 on an absent route is a structural signal, not a transport error.
        raise LiveFetchUnsupported(f"{path} -> HTTP {e.code}") from None
    except urllib.error.URLError as e:
        raise BackendError(f"request failed: {e}") from None
    if status != 200:
        raise LiveFetchUnsupported(f"{path} -> HTTP {status}")
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise BackendError(f"unparseable JSON from {path}: {e}") from None


def unwrap(data):
    """vibe-kanban wraps responses in {success, data, message}; some routes
    return raw arrays/objects. Return the payload either way."""
    if isinstance(data, dict) and "success" in data:
        if data.get("success") is True:
            return data.get("data")
        raise BackendError(data.get("message") or "request failed")
    return data


# --------------------------------------------------------------------------
# Live fetch
# --------------------------------------------------------------------------

def fetch_projects(base):
    data = unwrap(http_get_json(base, "/api/projects"))
    return data if isinstance(data, list) else []


def boards_in_scope(projects, root_id):
    """The named project plus descendant boards (walk parent_id, visited set)."""
    by_id = {p.get("id"): p for p in projects if isinstance(p, dict) and p.get("id")}
    if root_id and root_id not in by_id:
        return []
    roots = [root_id] if root_id else list(by_id.keys())
    out, seen, queue = [], set(), deque(roots)
    while queue:
        pid = queue.popleft()
        if pid in seen or pid not in by_id:
            continue
        seen.add(pid)
        out.append(by_id[pid])
        for child_id, child in by_id.items():
            if child.get("parent_id") == pid and child_id not in seen:
                queue.append(child_id)
    return out


def fetch_statuses(base, project_id):
    data = unwrap(http_get_json(base, "/api/project-statuses", query={"project_id": project_id}))
    return data if isinstance(data, list) else []


def fetch_issues(base, project_id):
    """Best-effort paged fetch of /api/issues?project_id=. The MCP `list_issues`
    is the canonical reader; this route is not contractually documented, so a
    404/odd shape raises LiveFetchUnsupported and the CLI points at --input."""
    rows = []
    limit, offset = 100, 0
    while True:
        try:
            page = unwrap(http_get_json(
                base, "/api/issues",
                query={"project_id": project_id, "limit": limit, "offset": offset},
            ))
        except LiveFetchUnsupported:
            raise
        if not isinstance(page, list):
            raise LiveFetchUnsupported("/api/issues returned non-list")
        rows.extend(page)
        if len(page) < limit:
            break
        offset += limit
        if offset > 5000:  # hard safety cap
            break
    return rows


def fetch_relationships(base, issue_ids):
    """Outgoing rows only (blocker side). Cap fan-out at RELATIONSHIP_CAP."""
    edges, queried, truncated = [], 0, False
    for iid in issue_ids:
        if queried >= RELATIONSHIP_CAP:
            truncated = True
            break
        queried += 1
        data = unwrap(http_get_json(base, "/api/issue-relationships", query={"issue_id": iid}))
        if not isinstance(data, list):
            continue
        for row in data:
            if not isinstance(row, dict):
                continue
            if row.get("relationship_type") == "blocking" and row.get("related_issue_id"):
                edges.append({
                    "blocker": iid,
                    "blocked": row["related_issue_id"],
                })
    return edges, {"queried": queried, "truncated": truncated, "cap": RELATIONSHIP_CAP}


def build_live_snapshot(base, project_id, restrict_simple_ids):
    projects = fetch_projects(base)
    boards = boards_in_scope(projects, project_id)
    if not boards:
        raise BackendError(f"project {project_id!r} not found on backend")

    statuses, issues = {}, []
    for b in boards:
        bid = b.get("id")
        rows = fetch_statuses(base, bid)
        statuses[bid] = rows
        try:
            issues.extend(fetch_issues(base, bid))
        except LiveFetchUnsupported as e:
            raise LiveFetchUnsupported(
                f"could not list issues live ({e}); pass a list_issues snapshot via --input"
            ) from None

    # Index issues; trim to selected simple_ids if requested.
    by_simple = {i.get("simple_id"): i for i in issues if isinstance(i, dict)}
    if restrict_simple_ids:
        missing = [s for s in restrict_simple_ids if s not in by_simple]
        if missing:
            raise BackendError(f"cards not found on board: {', '.join(missing)}")
        keep = set(restrict_simple_ids)
        issues = [i for i in issues if i.get("simple_id") in keep]

    live_meta = _status_meta_map(statuses)
    non_terminal_ids = [i.get("id") for i in issues
                        if i.get("id") and _status_of(i, live_meta)["role"] != ROLE_DONE]
    edges, gate = fetch_relationships(base, non_terminal_ids)

    return {
        "project_id": project_id,
        "boards": [{"id": b.get("id"), "name": b.get("name"), "parent_id": b.get("parent_id")}
                   for b in boards],
        "statuses": statuses,           # {board_id: [status rows]}
        "issues": issues,
        "relationships": [{"issue_id": e["blocker"], "related_issue_id": e["blocked"],
                           "relationship_type": "blocking"} for e in edges],
        "gate": gate,
    }


# --------------------------------------------------------------------------
# Column role resolution (same heuristic as reference/sweep.md)
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# Column role resolution (same heuristic as reference/sweep.md, +review)
# --------------------------------------------------------------------------

# Roles a card may sit in. CANDIDATES are never taken from EXCLUDED_ROLES.
ROLE_DONE = "terminal"
ROLE_REVIEW = "review"
ROLE_START = "start"
ROLE_OPEN = "open"
EXCLUDED_ROLES = {ROLE_DONE, ROLE_REVIEW}
REVIEW_NAME_RE = re.compile(r"review", re.IGNORECASE)


def _classify_board(status_rows):
    """Returns {status_id: role}.

    Roles: terminal (done + hidden), review (in review), start (in progress),
    open (backlog / other). terminal = last visible by sort_order, matching the
    app's own board-UI rule. review is detected by a name match (case-insensitive
    'review'), falling back to the second-to-last visible column when the board
    has >= 4 visible columns and no review-named column. start = second visible.
    """
    rows = [r for r in status_rows if isinstance(r, dict) and r.get("id")]
    visible = sorted([r for r in rows if not r.get("hidden")],
                     key=lambda r: r.get("sort_order", 0))
    roles = {}
    for r in rows:
        if r.get("hidden"):
            roles[r["id"]] = ROLE_DONE
    if not visible:
        return roles
    roles[visible[-1]["id"]] = ROLE_DONE  # last visible column = done

    review_id = None
    for r in visible:
        if r["id"] == visible[-1]["id"]:
            continue
        if REVIEW_NAME_RE.search(r.get("name") or ""):
            review_id = r["id"]
            break
    if review_id is None and len(visible) >= 4:
        review_id = visible[-2]["id"]  # positional fallback
    if review_id is not None:
        roles[review_id] = ROLE_REVIEW

    if len(visible) >= 3:
        start_id = visible[1]["id"]
        if roles.get(start_id) not in (ROLE_DONE, ROLE_REVIEW):
            roles[start_id] = ROLE_START

    for r in visible:
        roles.setdefault(r["id"], ROLE_OPEN)
    return roles


def _status_meta_map(statuses):
    """Build {project_id: {status_id: {"name", "role"}}}.

    `statuses` may be {board_id: [rows]} (preferred) or a flat list grouped by
    each row's project_id."""
    def build(rows):
        roles = _classify_board(rows)
        meta = {}
        for r in rows:
            if isinstance(r, dict) and r.get("id"):
                meta[r["id"]] = {"name": r.get("name"), "role": roles.get(r["id"], ROLE_OPEN)}
        return meta

    if isinstance(statuses, dict):
        return {bid: build(rows) for bid, rows in statuses.items()}
    flat = statuses if isinstance(statuses, list) else []
    grouped = defaultdict(list)
    for r in flat:
        if isinstance(r, dict):
            grouped[r.get("project_id")].append(r)
    return {pid: build(rows) for pid, rows in grouped.items()}


def _status_of(issue, meta):
    """Return {"name", "role"} for an issue, defaulting to open when unknown."""
    pid = issue.get("project_id")
    sid = issue.get("status_id") or issue.get("statusId")
    found = (meta.get(pid) or {}).get(sid) or (meta.get(None) or {}).get(sid)
    if found:
        return found
    return {"name": issue.get("status_name") or issue.get("statusName"),
            "role": ROLE_OPEN}


# --------------------------------------------------------------------------
# Snapshot loading (--input)
# --------------------------------------------------------------------------

def load_snapshot(path):
    if path == "-":
        raw = sys.stdin.read()
    else:
        raw = Path(path).read_text(encoding="utf-8")
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise BackendError(f"--input is not valid JSON: {e}")
    if not isinstance(data, dict) or "issues" not in data:
        raise BackendError("--input must be a JSON object with an `issues` array")
    data.setdefault("statuses", {})
    data.setdefault("relationships", [])
    data.setdefault("boards", [])
    return data


# --------------------------------------------------------------------------
# The planner
# --------------------------------------------------------------------------

def parse_tier(description):
    if not description:
        return None
    m = ROUTING_RE.search(description)
    if not m:
        return None
    tier = m.group(1).lower()
    return tier if tier in TIER_RANK else None


def _root_parent(issue, by_id):
    """Walk parent_issue_id up to the root ancestor (may be the card itself)."""
    cur = issue
    seen = set()
    while True:
        pid = cur.get("parent_issue_id") or cur.get("parentIssueId")
        if not pid or pid in seen or pid not in by_id:
            return cur
        seen.add(pid)
        cur = by_id[pid]


def plan(snapshot, restrict_simple_ids=None, wip_cap=DEFAULT_WIP_CAP):
    issues = [i for i in snapshot.get("issues", []) if isinstance(i, dict) and i.get("id")]
    by_id = {i["id"]: i for i in issues}
    meta = _status_meta_map(snapshot.get("statuses", {}))

    def role_of(issue):
        return _status_of(issue, meta)["role"]

    # Leaves only: a card that is some other card's parent is a container and is
    # never dispatched (existing rule). Parents are excluded from waves entirely.
    parent_ids = {
        (i.get("parent_issue_id") or i.get("parentIssueId"))
        for i in issues
        if i.get("parent_issue_id") or i.get("parentIssueId")
    }
    leaf_ids = {i["id"] for i in issues if i["id"] not in parent_ids}

    # Two sets:
    #   graph_ids   — non-terminal leaves (Todo, In Progress, In Review). These
    #                 participate in the dependency graph. Review cards are
    #                 in-flight blockers for their dependents, so they MUST stay
    #                 in the graph as known nodes (not "unverified").
    #   candidates  — leaves NOT in review and NOT terminal (Todo, In Progress).
    #                 These are the cards we will actually plan / dispatch. The
    #                 --cards filter restricts only this output set, never the
    #                 graph: dependency resolution always sees the full board.
    graph_ids = {i["id"] for i in issues if i["id"] in leaf_ids and role_of(i) != ROLE_DONE}
    candidates = {i["id"]: i for i in issues
                  if i["id"] in graph_ids and role_of(i) not in EXCLUDED_ROLES}
    if restrict_simple_ids:
        keep = {i["id"] for i in issues if i.get("simple_id") in set(restrict_simple_ids)}
        candidates = {k: v for k, v in candidates.items() if k in keep}

    terminal_ids = {i["id"] for i in issues if role_of(i) == ROLE_DONE}
    review_ids = {i["id"] for i in issues if role_of(i) == ROLE_REVIEW}

    # Effective blocking edges over the graph. Terminal blockers are satisfied
    # and dropped. Blockers outside the graph (and not terminal) are unverified.
    rel = snapshot.get("relationships", [])
    edges = []  # (blocker, blocked)
    unverified = defaultdict(list)  # blocked -> [unknown blocker ids]
    for row in rel:
        if not isinstance(row, dict):
            continue
        if row.get("relationship_type") != "blocking":
            continue
        blocker = row.get("issue_id") or row.get("blocker") or row.get("source_issue_id")
        blocked = row.get("related_issue_id") or row.get("blocked") or row.get("target_issue_id")
        if not blocker or not blocked or blocked not in graph_ids:
            continue
        if blocker in terminal_ids:
            continue  # satisfied (shipped)
        if blocker in graph_ids:
            edges.append((blocker, blocked))
        else:
            unverified[blocked].append(blocker)

    waves, cycles = _topological_waves(graph_ids, edges)

    # Lanes: group CANDIDATES by root parent.
    lane_roots = {}
    for c in candidates.values():
        root = _root_parent(c, by_id)
        lane_roots.setdefault(root["id"], root)
    root_to_letter = {
        rid: chr(ord("A") + idx)
        for idx, rid in enumerate(sorted(lane_roots, key=lambda r: _simple(lane_roots[r])))
    }

    lanes_out = []
    for rid, root in sorted(lane_roots.items(), key=lambda kv: root_to_letter[kv[0]]):
        members = [c for c in candidates.values() if _root_parent(c, by_id)["id"] == rid]
        by_wave = defaultdict(list)
        for c in members:
            by_wave[waves.get(c["id"])].append(c)  # wave may be None (cycle/unverified)
        waves_out = []
        for w in sorted(by_wave, key=lambda x: (x is None, x)):
            cards = sorted(
                by_wave[w],
                key=lambda c: (TIER_RANK.get(parse_tier(c.get("description")), 99),
                               _simple(c), c.get("title") or ""),
            )
            waves_out.append({
                "wave": None if w is None else w,
                "cards": [_card_view(c, by_id, meta, waves.get(c["id"]),
                                     [s for (s, b) in edges if b == c["id"]],
                                     unverified.get(c["id"], [])) for c in cards],
            })
        lanes_out.append({
            "lane": root_to_letter[rid],
            "parent": {"id": rid, "simple_id": _simple(root),
                       "title": root.get("title") or ""},
            "waves": waves_out,
        })

    # `next`: wave-0 candidates across lanes, ordered (tier, simple_id), WIP-capped.
    zero = [c for c in candidates.values()
            if waves.get(c["id"]) == 0 and not unverified.get(c["id"])]
    zero.sort(key=lambda c: (TIER_RANK.get(parse_tier(c.get("description")), 99),
                             _simple(c), c.get("title") or ""))
    next_out = [{"lane": root_to_letter[_root_parent(c, by_id)["id"]],
                 "id": c["id"], "simple_id": _simple(c), "title": c.get("title") or "",
                 "column": _status_of(c, meta)}
                for c in zero[:wip_cap]]

    errors = []
    if cycles:
        errors.append({
            "type": "cycle",
            "cards": sorted({_simple(by_id[c]) for c in cycles if c in by_id}),
            "ids": sorted(cycles),
        })
    held_unverified = [
        {"id": cid, "simple_id": _simple(candidates[cid]),
         "column": _status_of(candidates[cid], meta),
         "unverified_blockers": sorted({(b if b not in by_id else _simple(by_id[b]))
                                        for b in unverified.get(cid, [])})}
        for cid in sorted(candidates)
        if unverified.get(cid)
    ]
    if held_unverified:
        errors.append({"type": "unverified_blockers", "cards": held_unverified})

    gate = snapshot.get("gate") or {}
    if isinstance(gate, dict) and gate.get("truncated"):
        errors.append({
            "type": "dependency_gate_truncated",
            "queried": gate.get("queried"),
            "cap": gate.get("cap", RELATIONSHIP_CAP),
        })

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "project_id": snapshot.get("project_id"),
        "boards": snapshot.get("boards", []),
        "columns": _columns_summary(meta),
        "counts": {
            "candidates": len(candidates),
            "terminal_excluded": len(terminal_ids & leaf_ids),
            "review_excluded": len(review_ids & leaf_ids),
            "parents_excluded": len(parent_ids & set(by_id)),
            "lanes": len(lanes_out),
            "next": len(next_out),
        },
        "lanes": lanes_out,
        "next": next_out,
        "errors": errors,
    }


def _topological_waves(nodes, edges):
    """Layered topological sort. Returns ({node: wave}, set(cycle nodes)).

    wave 0 = no incoming edge. A node that can never be placed is in a cycle.
    Edges are (blocker, blocked): blocker must finish first.
    """
    adj = defaultdict(list)      # blocker -> [blocked]
    indeg = defaultdict(int)
    for a, b in edges:
        adj[a].append(b)
        indeg[b] += 1
    for n in nodes:
        indeg.setdefault(n, 0)

    wave = {}
    q = deque(n for n in nodes if indeg[n] == 0)
    level = 0
    while q:
        nxt = []
        for _ in range(len(q)):
            n = q.popleft()
            wave[n] = level
            for m in adj[n]:
                indeg[m] -= 1
                if indeg[m] == 0:
                    nxt.append(m)
        q = deque(nxt)
        level += 1

    cycles = {n for n in nodes if n not in wave}
    return wave, cycles


def _simple(issue):
    return issue.get("simple_id") or issue.get("simpleId") or issue.get("id")


def _card_view(c, by_id, meta, wave, blocked_by_ids, unverified_ids):
    def label(iid):
        return _simple(by_id[iid]) if iid in by_id else iid
    status = _status_of(c, meta)
    return {
        "id": c["id"],
        "simple_id": _simple(c),
        "title": c.get("title") or "",
        "column": status,
        "tier": parse_tier(c.get("description")),
        "wave": wave,
        "blocked_by": sorted({label(i) for i in blocked_by_ids}),
        "unverified_blockers": sorted({label(i) for i in unverified_ids}),
    }


def _columns_summary(meta):
    out = {}
    for pid, status_map in meta.items():
        by_role = defaultdict(int)
        for entry in status_map.values():
            by_role[entry["role"]] += 1
        out[pid] = dict(by_role)
    return out


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------

def render_json(plan):
    print(json.dumps(plan, indent=2))


def render_pretty(plan):
    lines = []
    cnt = plan["counts"]
    lines.append(f"ship plan — {cnt['candidates']} candidate(s), {cnt['lanes']} lane(s) "
                 f"(next: {cnt['next']})")
    excluded = []
    if cnt.get("review_excluded"):
        excluded.append(f"{cnt['review_excluded']} in-review")
    if cnt.get("terminal_excluded"):
        excluded.append(f"{cnt['terminal_excluded']} done")
    if cnt.get("parents_excluded"):
        excluded.append(f"{cnt['parents_excluded']} parent(s)")
    if excluded:
        lines.append(f"excluded: {', '.join(excluded)}")
    for lane in plan["lanes"]:
        lines.append("")
        lines.append(f"lane {lane['lane']} — {lane['parent']['simple_id']}: "
                     f"{lane['parent']['title']}")
        for w in lane["waves"]:
            wlabel = "wave ?" if w["wave"] is None else f"wave {w['wave']}"
            for c in w["cards"]:
                tier = f"[{c['tier']}]" if c["tier"] else "[?]"
                col = c.get("column") or {}
                colname = col.get("name") or "?"
                flags = []
                if c["blocked_by"]:
                    flags.append(f"blocked by {','.join(c['blocked_by'])}")
                if c["unverified_blockers"]:
                    flags.append(f"UNVERIFIED:{','.join(c['unverified_blockers'])}")
                tail = f"  ({'; '.join(flags)})" if flags else ""
                lines.append(f"  {wlabel:<8} {c['simple_id']:<10} {tier:<9} "
                             f"[{colname}] {c['title']}{tail}")
    if plan["next"]:
        lines.append("")
        lines.append("dispatch now (WIP-capped):")
        for n in plan["next"]:
            col = n.get("column") or {}
            lines.append(f"  {n['lane']}  {n['simple_id']:<10} [{col.get('name') or '?'}]  "
                         f"{n['title']}")
    for err in plan["errors"]:
        lines.append("")
        if err["type"] == "cycle":
            lines.append(f"! blocking cycle: {' -> '.join(err['cards'])} (filing error)")
        elif err["type"] == "unverified_blockers":
            for c in err["cards"]:
                lines.append(f"! {c['simple_id']}: unverified blocker(s) "
                             f"{', '.join(c['unverified_blockers'])} — held")
        elif err["type"] == "dependency_gate_truncated":
            lines.append(f"! dependency gate truncated at cap {err['cap']} "
                         f"(queried {err['queried']}) — some candidates held unverified")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def build_parser():
    p = argparse.ArgumentParser(
        prog="ship_planner.py",
        description="Build a ship plan (lanes x waves) for a vibe-kanban board.",
    )
    sub = p.add_subparsers(dest="command", required=True)

    pp = sub.add_parser("plan", help="Build the lane/wave plan and print it.")
    pp.add_argument("--input", "-i", metavar="FILE",
                    help="Offline snapshot JSON (issues+statuses+relationships). "
                         "'-' reads stdin. Skips all live fetch.")
    pp.add_argument("--project", metavar="ID",
                    help="Project id (live mode). Ignored when --input carries project_id.")
    pp.add_argument("--cards", metavar="LIST",
                    help="Comma-separated simple_ids to restrict the plan to.")
    pp.add_argument("--wip-cap", type=int, default=DEFAULT_WIP_CAP,
                    help=f"Max cards in `next` (default {DEFAULT_WIP_CAP}).")
    pp.add_argument("--pretty", action="store_true",
                    help="Print a human-readable digest instead of JSON.")
    pp.add_argument("--backend", metavar="URL",
                    help="Override the backend URL (else VIBE_BACKEND_URL/port file).")
    return p


def _parse_cards(raw):
    if not raw:
        return None
    return [s.strip() for s in raw.split(",") if s.strip()]


def cmd_plan(args):
    restrict = _parse_cards(args.cards)

    if args.input:
        snapshot = load_snapshot(args.input)
    else:
        if not args.project:
            sys.stderr.write("plan: --project <id> is required in live mode "
                             "(or pass --input for offline planning)\n")
            sys.exit(2)
        base = require_backend(args.backend)
        try:
            snapshot = build_live_snapshot(base, args.project, restrict)
        except LiveFetchUnsupported as e:
            sys.stderr.write(f"live fetch unsupported: {e}\n"
                             "provide a snapshot via --input instead\n")
            sys.exit(1)
        except BackendError as e:
            sys.stderr.write(f"backend error: {e}\n")
            sys.exit(1)

    if not args.input and args.project and "project_id" not in snapshot:
        snapshot["project_id"] = args.project

    result = plan(snapshot, restrict_simple_ids=restrict, wip_cap=args.wip_cap)
    if args.pretty:
        print(render_pretty(result))
    else:
        render_json(result)
    sys.exit(0)


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "plan":
        cmd_plan(args)


if __name__ == "__main__":
    main()
