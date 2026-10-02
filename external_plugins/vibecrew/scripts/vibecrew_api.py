#!/usr/bin/env python3
"""vibecrew_api.py — stdlib-only HTTP client CLI over the VibeCrew REST API.

This is the ONE way every vibecrew skill/agent/prompt talks to the board:

    python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py <subcommand> ...

No third-party dependencies (no `requests`, no pip installs) — only
`urllib.request`, `urllib.parse`, `urllib.error`, `json`, `argparse`, `os`,
`pathlib`, `sys`. It must run from any executor's bare `python3`.

Base-URL resolution order (first hit wins):
  1. $VIBECREW_URL              — a full URL, used verbatim.
  2. ~/.vibecrew/instance.json  — read its "port" field (may be absent).
  3. ~/.vibecrew/port           — a plain integer written by CrewRuntime.
  4. http://127.0.0.1:48620     — CrewRuntime.defaultPort.

Every subcommand probes `GET /health` (the leaf path, NOT /api/health) first.
On a failed/non-200 probe: exit 3, "VibeCrew is not running — launch the app"
on stderr. That is the "backend down" contract every skill/agent keys off.

Every /api/* response is the envelope `{success, data, message}`:
  - success:true  -> print `data` as JSON to stdout, exit 0.
  - success:false -> print `message` to stderr, exit 1.
Argparse usage/argument errors keep argparse's own exit 2.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_PORT = 48620
DOWN_MESSAGE = "VibeCrew is not running — launch the app"


# --------------------------------------------------------------------------
# Base URL resolution
# --------------------------------------------------------------------------

def resolve_base_url():
    """First hit wins. Never hard-fails on a missing/unparseable tier-2/3 file."""
    # 1. $VIBECREW_URL, verbatim (strip one trailing slash).
    env_url = os.environ.get("VIBECREW_URL")
    if env_url:
        return env_url[:-1] if env_url.endswith("/") else env_url

    # 2. ~/.vibecrew/instance.json -> {"port": N}
    instance_path = Path.home() / ".vibecrew" / "instance.json"
    try:
        with open(instance_path, encoding="utf-8") as f:
            data = json.load(f)
        port = data.get("port")
        if isinstance(port, int):
            return f"http://127.0.0.1:{port}"
        if isinstance(port, str) and port.strip().isdigit():
            return f"http://127.0.0.1:{int(port.strip())}"
    except (OSError, ValueError, AttributeError, TypeError):
        pass  # tolerate absence/unparseable — fall through

    # 3. ~/.vibecrew/port -> plain integer text
    port_path = Path.home() / ".vibecrew" / "port"
    try:
        text = port_path.read_text(encoding="utf-8").strip()
        if text.isdigit():
            return f"http://127.0.0.1:{int(text)}"
    except OSError:
        pass  # tolerate absence — fall through

    # 4. Default
    return f"http://127.0.0.1:{DEFAULT_PORT}"


# --------------------------------------------------------------------------
# Health probe
# --------------------------------------------------------------------------

def probe_health(base, for_health_subcommand=False):
    """GET {base}/health (leaf path, NOT /api/health). On failure/non-200: exit 3.

    Returns the raw parsed JSON body (not enveloped) when for_health_subcommand
    is True and the probe succeeds — the health route itself is raw
    {"status": "ok"}, not wrapped in {success, data, message}.
    """
    url = f"{base}/health"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            status = resp.getcode()
            body = resp.read()
    except Exception:
        print(DOWN_MESSAGE, file=sys.stderr)
        sys.exit(3)

    if status != 200:
        print(DOWN_MESSAGE, file=sys.stderr)
        sys.exit(3)

    if for_health_subcommand:
        try:
            return json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {"status": "ok"}
    return None


# --------------------------------------------------------------------------
# Request helper
# --------------------------------------------------------------------------

def build_path(*segments):
    """Join path segments, URL-quoting every dynamic (opaque-id) segment."""
    quoted = [urllib.parse.quote(str(s), safe="") for s in segments]
    return "/" + "/".join(quoted)


def request(base, method, path, body=None, query=None, timeout=120):
    """Perform one HTTP request and return (status_code, raw_bytes).

    body=None sends NO request body (no Content-Type) — use only for GETs and
    for POSTs the server does not decode (stop). Every POST/PATCH whose route
    decodes a body must pass a JSON object, even {} — never None.
    """
    url = base + path
    if query:
        qs = urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        if qs:
            url = f"{url}?{qs}"

    headers = {}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, method=method, data=data, headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.getcode(), resp.read()
    except urllib.error.HTTPError as e:
        # The server envelopes error statuses too, and `rebase` returns a
        # data-bearing 409 with success:true — always read the body.
        return e.code, e.read()
    except urllib.error.URLError as e:
        print(f"request failed: {e}", file=sys.stderr)
        sys.exit(1)


def unwrap(raw_bytes):
    """Parse the {success, data, message} envelope and print/exit accordingly."""
    try:
        envelope = json.loads(raw_bytes.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        sys.stderr.write(raw_bytes.decode("utf-8", errors="replace"))
        sys.stderr.write("\n")
        sys.exit(1)

    if not isinstance(envelope, dict) or "success" not in envelope:
        # Not a recognizable envelope — treat as raw failure output.
        sys.stderr.write(json.dumps(envelope))
        sys.stderr.write("\n")
        sys.exit(1)

    if envelope.get("success") is True:
        print(json.dumps(envelope.get("data"), indent=2))
        sys.exit(0)
    else:
        message = envelope.get("message") or "request failed"
        print(message, file=sys.stderr)
        sys.exit(1)


def call(base, method, path, body=None, query=None):
    """probe_health -> request -> unwrap, the standard subcommand flow."""
    probe_health(base)
    status, raw = request(base, method, path, body=body, query=query)
    unwrap(raw)


def fetch_nudge_text(base, run_id):
    """The host-composed `VC-NUDGE:` text for `run_id`, or exit non-zero.

    Exits 1 with `nudge_cap_reached` when the host's cap holds (it has already
    reported the run; sending would 409 anyway), and with a version hint on a
    404 from an app older than the route — report the stall instead of nudging.
    """
    probe_health(base)
    status, raw = request(base, "GET", build_path("api", "runs", run_id, "nudge"))
    try:
        envelope = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        envelope = None
    if status != 200 or not isinstance(envelope, dict) or envelope.get("success") is not True:
        message = envelope.get("message") if isinstance(envelope, dict) else None
        note = (" — no such run, or a VibeCrew older than /nudge: report the stall, "
                "don't nudge") if status == 404 else ""
        print(f"GET /nudge returned HTTP {status}: {message or 'request failed'}{note}",
              file=sys.stderr)
        sys.exit(1)
    data = envelope.get("data") or {}
    if data.get("cap_reached"):
        print("nudge_cap_reached — the host has stopped nudging this run and "
              "reported it for operator review", file=sys.stderr)
        sys.exit(1)
    text = data.get("text")
    if not text:
        print("GET /nudge returned no text", file=sys.stderr)
        sys.exit(1)
    return text


DOCTOR_MARKERS = {
    "ok": "ok",
    "warn": "warn",
    "fail": "FAIL",
    "timed_out": "timeout",
    "skipped": "skip",
}
DOCTOR_ATTENTION_STATES = ("fail", "warn", "timed_out")


def render_doctor_rows(rows):
    """The server's own transcript format, re-rendered for a filtered row set.

    Kept byte-compatible with `DoctorReport.render` on the Swift side so a
    `--failing` excerpt and the full `transcript` field read identically.
    """
    lines = []
    for row in rows:
        marker = DOCTOR_MARKERS.get(row.get("state", ""), row.get("state", "?"))
        line = "[%s] %s \u2014 %s" % (marker, row.get("title", ""), row.get("detail", ""))
        value = row.get("value")
        if value:
            line += " (%s)" % value
        hint = row.get("hint")
        if hint:
            line += "\n      fix: %s" % hint
        lines.append(line)
    return "\n".join(lines)


def doctor(base, as_text=False, failing_only=False):
    """GET /api/doctor, with the two shapes an operator or agent wants.

    Exit code stays 0 for a reachable backend even when rows are red: the
    doctor DIAGNOSES, and a red row is a successful diagnosis, not a failed
    request. Use the `state` field (or `summary.healthy`) to branch.
    """
    probe_health(base)
    status, raw = request(base, "GET", "/api/doctor")

    def fail(detail):
        # `/health` answered but `/api/doctor` did not, so the likeliest
        # cause by far is a VibeCrew older than the route. Say so — an
        # unexplained bare exit 1 sends the operator hunting the wrong thing.
        note = " — is VibeCrew up to date?" if status == 404 else ""
        print(f"/api/doctor returned HTTP {status}: {detail}{note}", file=sys.stderr)
        sys.exit(1)

    try:
        envelope = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        fail(raw.decode("utf-8", errors="replace").strip() or "(no body)")
        return
    if not isinstance(envelope, dict) or envelope.get("success") is not True:
        message = envelope.get("message") if isinstance(envelope, dict) else None
        fail(message or json.dumps(envelope))
        return

    data = envelope.get("data") or {}
    rows = data.get("rows") or []
    if failing_only:
        rows = [r for r in rows if r.get("state") in DOCTOR_ATTENTION_STATES]

    if as_text:
        summary = data.get("summary") or {}
        print(
            "VibeCrew doctor \u2014 %s ok, %s to look at, %s blocking, %s timed out"
            % (
                summary.get("ok", 0), summary.get("warn", 0),
                summary.get("fail", 0), summary.get("timed_out", 0),
            )
        )
        rendered = render_doctor_rows(rows)
        if rendered:
            print(rendered)
        elif failing_only:
            print("[ok] Everything checks out.")
    else:
        out = dict(data)
        out["rows"] = rows
        print(json.dumps(out, indent=2))
    sys.exit(0)


# --------------------------------------------------------------------------
# argparse plumbing
# --------------------------------------------------------------------------

def add_common(parser):
    return parser


def parse_answers_json(raw):
    try:
        parsed = json.loads(raw)
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"--answers-json is not valid JSON: {e}")
    if not isinstance(parsed, list):
        raise argparse.ArgumentTypeError("--answers-json must be a JSON array")
    for entry in parsed:
        if not isinstance(entry, dict) or "question" not in entry or "answer" not in entry:
            raise argparse.ArgumentTypeError(
                '--answers-json entries must be {"question": "...", "answer": ["..."]}'
            )
        if not isinstance(entry["answer"], list):
            raise argparse.ArgumentTypeError(
                "each entry's \"answer\" must be a list of strings"
            )
    return parsed


def read_description(args):
    """Resolve --description / --description-file into a single string, or None."""
    if getattr(args, "description_file", None):
        try:
            return Path(args.description_file).read_text(encoding="utf-8")
        except OSError as e:
            print(f"cannot read --description-file: {e}", file=sys.stderr)
            sys.exit(2)
    return getattr(args, "description", None)


def parse_stage_pairs(pairs, flag):
    """Parse repeated `STAGE=VALUE` flags into {stage: value-or-None}.

    An empty value (`--stage-agent plan-review=`) sends JSON `null`, which the
    compose endpoint reads as "clear the pipeline file's own entry for this
    stage" so the step inherits the main loop.
    """
    out = {}
    for pair in pairs or []:
        stage, sep, value = pair.partition("=")
        stage = stage.strip()
        if not sep or not stage:
            print(f"{flag} expects STAGE=VALUE (got {pair!r})", file=sys.stderr)
            sys.exit(2)
        value = value.strip()
        out[stage] = value or None
    return out


PIPELINE_START = "<!-- vk:pipeline:start -->"
PIPELINE_END = "<!-- vk:pipeline:end -->"
# ``N. Create spec — `id: spec` `` — the reference form's stage line. Mirrors
# `CardPipeline.numberedListItemPattern` + `stageIdSuffixPattern` on the Swift
# side; keep the two in step.
STAGE_LINE_RE = re.compile(r"^\s*\d+\.\s+.*\s+—\s+`id:\s*([A-Za-z0-9._-]+)`\s*$")


def block_stage_ids(description):
    """The ticked stage ids, in the order the card's `## Pipeline` block lists them.

    Empty for a full-text block (no `id:` suffixes) or no block at all.

    Anchored the way every other reader anchors: the LAST standalone start
    marker, the first standalone end marker after it. A marker quoted inside a
    prose line is not a delimiter.
    """
    lines = (description or "").split("\n")
    starts = [i for i, l in enumerate(lines) if l.strip() == PIPELINE_START]
    if not starts:
        return []
    begin = starts[-1]
    ends = [i for i in range(begin + 1, len(lines)) if lines[i].strip() == PIPELINE_END]
    stop = ends[0] if ends else len(lines)

    ids, started = [], False
    for line in lines[begin + 1:stop]:
        match = STAGE_LINE_RE.match(line)
        if match:
            ids.append(match.group(1))
            started = True
            continue
        # Only the CONTIGUOUS numbered run is the stage list — same rule as
        # `parseStages`, so numbered custom text below it is not counted.
        if started:
            break
    return ids


def card_stages(base, card_id, stage_id=None, as_text=False):
    """A4 — re-render the card's pipeline stages and print their full prompts.

    A card composed in REFERENCE form carries only stage names plus an `id:`;
    the prompts were left out precisely so they would stop riding into every
    stage, hand-off and resume. This is how an agent gets them back.

    The rendering is not re-implemented here. We read the card's own
    `extension_metadata.pipeline` — the pipeline name, the ticked ids, the
    executor/model pins and the per-stage bindings the card was FILED with —
    and hand them straight back to `POST /api/pipelines/:name/compose`, which
    runs `PipelineComposer` on the Swift side. So what prints is byte-identical
    to what a full-text block would have inlined, and it cannot drift: there is
    one renderer, and this is a client of it.

    A card with no pipeline metadata (hand-written block, pre-composer card)
    exits non-zero and says so, rather than printing an empty roster that would
    read as "this card has no stages".
    """
    probe_health(base)
    status, raw = request(base, "GET", build_path("api", "cards", card_id))
    try:
        card = json.loads(raw.decode("utf-8")).get("data") or {}
    except (ValueError, UnicodeDecodeError, AttributeError):
        sys.stderr.write(raw.decode("utf-8", errors="replace") + "\n")
        sys.exit(1)
    if not card:
        print(f"no card {card_id}", file=sys.stderr)
        sys.exit(1)

    # `extension_metadata` is a STRING column on the wire — parse, don't assume.
    meta = card.get("extension_metadata")
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except ValueError:
            meta = None
    pipeline = (meta or {}).get("pipeline") if isinstance(meta, dict) else None
    if not isinstance(pipeline, dict) or not pipeline.get("name"):
        print(
            "this card carries no pipeline metadata, so its stages cannot be "
            "re-rendered. Read the `## Pipeline` block in the card description "
            "directly — a card filed before the composer, or hand-edited, keeps "
            "its stage text inline.",
            file=sys.stderr)
        sys.exit(1)

    # THE BLOCK IS THE CONTRACT. The metadata says what the card was FILED with;
    # the `## Pipeline` block is what the agent was told to execute and what its
    # `VK-PIPELINE-STAGE: N` numbers refer to. They normally agree — the composer
    # writes both — but a hand-edited block, or metadata that predates an edit,
    # makes them disagree, and resolving from the metadata would then silently
    # drop or renumber a stage the card says must not be skipped.
    meta_ids = pipeline.get("enabledIds") or []
    listed = block_stage_ids(card.get("description"))
    enabled = listed or meta_ids
    if listed and meta_ids and listed != meta_ids:
        print(
            "warning: the card's `## Pipeline` block and its stored pipeline metadata "
            f"disagree.\n  block lists:    {', '.join(listed)}\n"
            f"  metadata lists: {', '.join(meta_ids)}\n"
            "  Following the BLOCK — it is what the agent executes and what the "
            "stage numbers mean.",
            file=sys.stderr)
    if not enabled:
        print("this card ticks no pipeline stages", file=sys.stderr)
        sys.exit(1)

    body = {"enabled_ids": enabled}
    for key, field in (("executor", "executor"), ("model", "model"),
                       ("custom_text", "customText")):
        value = pipeline.get(field)
        if value is not None:
            body[key] = value
    # Only the stages that actually differ are recorded, which is exactly what
    # compose wants back; absent means "inherit", the same as at filing time.
    if pipeline.get("stageAgents"):
        body["stage_agents"] = pipeline["stageAgents"]
    if pipeline.get("stageModels"):
        body["stage_models"] = pipeline["stageModels"]

    name = pipeline["name"]
    status, raw = request(
        base, "POST", build_path("api", "pipelines", name, "compose"), body=body)
    try:
        envelope = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        sys.stderr.write(raw.decode("utf-8", errors="replace") + "\n")
        sys.exit(1)
    if envelope.get("success") is not True:
        print(envelope.get("message") or f"could not compose \"{name}\"", file=sys.stderr)
        sys.exit(1)

    steps = (envelope.get("data") or {}).get("steps") or []
    # compose returns the WHOLE roster, ticked or not. The block numbers only
    # the ticked ones — mirror that exactly, or stage 2 here would not be the
    # stage the card calls 2 and `VK-PIPELINE-STAGE: 2` would point at the wrong
    # prompt. Order by `enabled`, which is the block's own sequence when we could
    # read one (normally identical to catalog order, but a hand-edited block is
    # still the thing being executed).
    by_id = {s.get("id"): s for s in steps}
    steps = [by_id[i] for i in enabled if i in by_id]
    missing = [i for i in enabled if i not in by_id]
    if missing:
        print(f"warning: the block lists stage(s) the pipeline has no prompt for: "
              f"{', '.join(missing)}", file=sys.stderr)
    if stage_id:
        steps = [s for s in steps if s.get("id") == stage_id]
        if not steps:
            print(f"stage \"{stage_id}\" is not ticked on this card", file=sys.stderr)
            sys.exit(1)

    if not as_text:
        print(json.dumps(steps, indent=2))
        sys.exit(0)

    for index, step in enumerate(steps, start=1):
        header = f"{index}. {step.get('label') or step.get('id')}  [id: {step.get('id')}]"
        binding = " · ".join(
            filter(None, [
                f"agent: {step['agent']}" if step.get("agent") else None,
                f"model: {step['model']}" if step.get("model") else None,
            ]))
        print(header + (f"  ({binding})" if binding else ""))
        print("-" * len(header))
        print(step.get("prompt", ""))
        print()
    sys.exit(0)


def read_extension_metadata(args):
    """Resolve --extension-metadata / --extension-metadata-file into a
    pre-serialized JSON string, or None.

    `UpdateCardBody.extensionMetadata` is a `String?` on the server (the store
    column is JSON text), so the object is re-serialized here — which also
    validates it before the request goes out.
    """
    text = getattr(args, "extension_metadata", None)
    if text is None:
        path = getattr(args, "extension_metadata_file", None)
        if not path:
            return None
        if path == "-":
            text = sys.stdin.read()
        else:
            try:
                text = Path(path).read_text(encoding="utf-8")
            except OSError as e:
                print(f"cannot read --extension-metadata-file: {e}", file=sys.stderr)
                sys.exit(2)
    try:
        parsed = json.loads(text)
    except ValueError as e:
        print(f"--extension-metadata is not valid JSON: {e}", file=sys.stderr)
        sys.exit(2)
    if not isinstance(parsed, dict):
        print("--extension-metadata must be a JSON object", file=sys.stderr)
        sys.exit(2)
    return json.dumps(parsed)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="vibecrew_api.py",
        description="Stdlib-only Python client CLI over the VibeCrew REST API "
        "(http://127.0.0.1:48620 by default). Resolves the backend URL, probes "
        "/health, unwraps the {success,data,message} envelope, and prints `data` "
        "as JSON. Exit codes: 0 success, 1 success:false, 2 argparse usage error, "
        "3 backend down.",
    )
    sub = parser.add_subparsers(dest="subcommand", required=True)

    # -- health / config / pipelines / projects / repos (slice 1) ----------
    sub.add_parser("health", help="GET /health — the connectivity probe itself.")
    sub.add_parser("config", help="GET /api/config — the config.*-prefixed KV rows.")
    p = sub.add_parser(
        "doctor",
        help="GET /api/doctor — the environment self-diagnosis: one row per "
        "check (agent CLIs on the RESOLVED launch PATH, tmux, gh auth, plugin "
        "catalog, handbook, pipelines, notifications, database and worktrees "
        "size) with a state and a one-line fix hint. Read-only; never spawns "
        "an agent. Exits 0 even when rows are red — branch on `state` or "
        "`summary.healthy`.",
    )
    p.add_argument(
        "--text", action="store_true",
        help="Print the plain-text transcript instead of JSON — one quotable "
        "line per row, with its fix underneath.",
    )
    p.add_argument(
        "--failing", action="store_true",
        help="Only rows that need attention (fail / warn / timed_out).",
    )
    sub.add_parser(
        "pipelines",
        help="GET /api/pipelines — every pipeline (bundled defaults + user "
        "overrides): name, source, agent, stage ids.",
    )
    p = sub.add_parser(
        "pipeline",
        help="GET /api/pipelines/:name — one pipeline's summary, binding "
        "tables (models/agents/efforts), and the raw TOML (the user "
        "override when one exists, else the bundled default).",
    )
    p.add_argument("name")
    p = sub.add_parser(
        "pipeline-put",
        help="PUT /api/pipelines/:name — validate + write a user pipeline "
        "TOML (creates one, or overrides the bundled default of the same "
        "name; the server refuses TOML that does not parse, or whose name = "
        "does not match the route). The TOML is read from --file, --toml, "
        "or stdin — RAW TOML on stdin, not JSON; the client wraps it.",
    )
    p.add_argument("name")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--file", help="path to a TOML file, or - for stdin (default: stdin)")
    g.add_argument("--toml", help="inline TOML text")
    p = sub.add_parser(
        "pipeline-compose",
        help="POST /api/pipelines/:name/compose — render the card's "
        "`## Pipeline` block and its extension_metadata for a set of enabled "
        "stages and per-step agent/model bindings, WITHOUT writing anything. "
        "Returns {block, extension_metadata, steps}: put `block` under the "
        "spec in the card description, then PATCH `extension_metadata` onto "
        "the created card with `card-update --extension-metadata`. Same code "
        "path as the app's composer, so a plugin-filed card and a UI-filed "
        "card are byte-identical for the same inputs.",
    )
    p.add_argument("name", help="pipeline name: Basic, Planned, Async, or a user pipeline "
                   "(removed legacy names 404 — list them with `pipelines`)")
    p.add_argument("--enabled-ids", required=True,
                   help="comma-separated stage ids to tick, e.g. "
                   "spec,plan,plan-review,code,merge")
    p.add_argument("--executor", help="main-loop executor raw value "
                   "(CLAUDE_CODE_HEADED, OPENCODE_HEADED, CODEX, PI, …)")
    p.add_argument("--model", help="main-loop model id")
    p.add_argument("--stage-agent", action="append", default=[], metavar="STAGE=RAW",
                   help="bind one delegable stage to another agent, e.g. "
                   "plan=CODEX. Repeatable. `STAGE=` (empty value) clears the "
                   "pipeline file's own binding so the stage inherits the main loop.")
    p.add_argument("--stage-model", action="append", default=[], metavar="STAGE=ID",
                   help="bind one delegable stage's model, e.g. "
                   "plan=gpt-5.6-sol. Repeatable. `STAGE=` clears the file's entry.")
    p.add_argument("--custom-text", help="custom instructions appended to the block")
    p = sub.add_parser(
        "knowledge-ask",
        help="GET /api/knowledge/ask — F5. Ask the two libraries: the operator "
        "handbook (cited `page \u00a7 section`, read through A4's INDEX.md) and "
        "this board's own memory (B4's index plus the vault's notes, cited as "
        "dossiers, reports, cards and notes). Every citation has been checked "
        "against its source before it is returned. No source found => `found: "
        "false` and the pinned nothing-found line; there is no path here that "
        "answers from a model's memory.",
    )
    p.add_argument("question", help="the operator's question, or a bare topic")
    p.add_argument("--library", choices=["both", "handbook", "project"],
                   help="narrow to one library (default: both)")
    p.add_argument("--limit", type=int, help="citations per source (default 6)")
    p.add_argument("--project", help="which project's vault folder to scan; "
                   "irrelevant when knowledge.vault_path is configured")
    p.add_argument("--text", action="store_true",
                   help="print the rendered answer instead of the JSON envelope")

    sub.add_parser("projects", help="GET /api/projects")
    sub.add_parser(
        "repos",
        help="GET /api/repos — repo ids (for per-repo delivery commands; a "
        "normal `start` needs none — its scope comes from the card's project).")

    # -- cards (slice 2) ------------------------------------------------------
    p = sub.add_parser(
        "cards",
        help="GET /api/cards?project_id=<id> — all cards for the project "
        "(includes description). --status filters CLIENT-SIDE (the route has "
        "no status query param).",
    )
    p.add_argument("--project-id", required=True)
    p.add_argument("--status", help="client-side filter on each card's status id")

    p = sub.add_parser("card", help="GET /api/cards/:id")
    p.add_argument("card_id")

    p = sub.add_parser(
        "stages",
        help="A4 — the full text of this card's pipeline stages, in order. A "
        "reference-form `## Pipeline` block carries stage NAMES; this "
        "re-renders the prompts through the server's own composer, so they are "
        "byte-identical to an inlined block. Default output is JSON; --text "
        "prints them for reading.",
    )
    p.add_argument("card_id")
    p.add_argument("--stage", help="only this stage id (e.g. `merge`)")
    p.add_argument("--text", action="store_true",
                   help="human-readable, one stage per section")

    p = sub.add_parser("card-create", help="POST /api/cards")
    p.add_argument("--project-id", required=True)
    p.add_argument("--title", required=True)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--description")
    g.add_argument("--description-file")
    p.add_argument("--priority")
    p.add_argument("--status")
    p.add_argument("--position", type=float)
    p.add_argument("--parent-card-id")
    p.add_argument("--parent-position", type=float)

    p = sub.add_parser("card-update", help="PATCH /api/cards/:id")
    p.add_argument("card_id")
    p.add_argument("--title")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--description")
    g.add_argument("--description-file")
    p.add_argument("--status")
    p.add_argument("--priority")
    p.add_argument("--position", type=float)
    p.add_argument("--parent-card-id")
    p.add_argument("--parent-position", type=float)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--extension-metadata", metavar="JSON",
                   help="the card's extension_metadata as a JSON OBJECT, sent "
                   "pre-serialized (the store column is JSON text). Typically "
                   "the `extension_metadata` returned by `pipeline-compose`, "
                   "e.g. --extension-metadata '{\"pipeline\": {…}}'. This "
                   "REPLACES the whole blob — merge client-side first if the "
                   "card already carries other keys (fetch it with `card`).")
    g.add_argument("--extension-metadata-file", metavar="PATH",
                   help="same, read from a file (or - for stdin) — use this "
                   "when the JSON is too big or too quote-heavy for argv")
    g.add_argument("--clear-extension-metadata", action="store_true",
                   help="write NULL over the card's extension_metadata")

    p = sub.add_parser(
        "card-prs",
        help="GET /api/cards/:id/pull-requests — PullRequestRecords only "
        "(status defaults to open); the PR-delivery Done corroborator. Does "
        "NOT surface direct merges (no queryable record for those).",
    )
    p.add_argument("card_id")

    p = sub.add_parser(
        "card-shipping-report",
        help="GET /api/cards/:id/shipping-report — the card's parsed "
        "SHIPPING-REPORT completion report (delivered, merge_commit, pr_url, "
        "commits, tests, docs, remaining, deviations). success:false (exit 1) "
        "when the card has no report yet, or the card is unknown.",
    )
    p.add_argument("card_id")

    p = sub.add_parser(
        "card-relationships",
        help="GET /api/cards/:id/relationships — OUTGOING rows only "
        "(WHERE card_id = :id): a card's own list shows who IT blocks, never "
        "who blocks it. Build incoming views by fanning out over the blockers.",
    )
    p.add_argument("card_id")

    p = sub.add_parser(
        "card-relate",
        help="POST /api/cards/:id/relationships — create an edge FROM card_id "
        "TO --related-card-id. For blocking, direction is blocker -> blocked: "
        "call this on the BLOCKER.",
    )
    p.add_argument("card_id")
    p.add_argument("--related-card-id", required=True)
    p.add_argument(
        "--type",
        default="blocking",
        choices=["blocking", "related", "has_duplicate"],
        help="relationship_type (default: blocking)",
    )

    p = sub.add_parser(
        "card-unrelate",
        help="DELETE /api/cards/:id/relationships/:relId — scoped to the "
        "owning card (the one the edge points FROM).",
    )
    p.add_argument("card_id")
    p.add_argument("--relationship-id", required=True)

    p = sub.add_parser(
        "comments",
        help="GET /api/cards/:id/comments — the card's comments, oldest-first "
        "(chronological, newest last).",
    )
    p.add_argument("card_id")

    p = sub.add_parser(
        "comment",
        help="POST /api/cards/:id/comments — leave a note on the card (the "
        "inter-agent/operator communication surface; never write into the card "
        "description). --body <text> only — there is no --body-file.",
    )
    p.add_argument("card_id")
    p.add_argument("--body", required=True)
    p.add_argument(
        "--kind", choices=["agent", "orchestrator", "operator", "auditor"], default="agent",
        help="author_kind (default: agent; auditor = the compliance reviewer's findings)",
    )
    p.add_argument("--label", help="optional author_label")
    p.add_argument("--run-id", help="optional run_id for traceability")

    p = sub.add_parser(
        "card-audit",
        help="GET /api/cards/:id/audit — the card's audit evidence bundle: "
        "card, spec/plan paperwork, finalization record (shipping report + "
        "merges + PRs + delivery signals), per-commit changed files, "
        "deterministic checks (has_spec/has_plan/delivered/paperwork_clean/"
        "merge_commits_resolvable), and the last final message. --diff adds "
        "full per-commit diffs (capped).",
    )
    p.add_argument("card_id")
    p.add_argument("--diff", action="store_true", help="include capped full diff text")

    p = sub.add_parser(
        "audit-unused-workspaces",
        help="GET /api/audit/unused-workspaces — workspaces with a "
        "conservative unused-reason (archived / worktree_deleted / ephemeral "
        "/ terminal card with corroborated delivery), newest-first, each "
        "with reasons, pinned, has_active_runs, and a deletable verdict. "
        "Deletion itself goes through workspace-delete, only for "
        "deletable:true rows.",
    )

    p = sub.add_parser(
        "auditor-ask",
        help="POST /api/auditor/ask — deliver a question to the LIVE auditor "
        "session (never spawns anything). 404 = no auditor launched; "
        "409 not_ready_for_input = mid-turn, retry later; 410 = its terminal "
        "is gone; 422 = not interactive.",
    )
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--text")
    g.add_argument("--text-file")

    p = sub.add_parser(
        "card-message",
        help="POST /api/host-messages target_kind=card — deliver a short notice "
        "to the development agent working <card_id> (the Auditor's VC-PR-FIX / "
        "VC-PR-APPROVED door). Live headed session: pasted; finished session: "
        "resumed with a follow-up. 404 = nobody seated on the card; "
        "409 not_ready_for_input = mid-turn, retry later; 410 = its terminal is gone.",
    )
    p.add_argument("card_id")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--text")
    g.add_argument("--text-file")

    # -- workspaces / launch / runs (slice 3) --------------------------------
    p = sub.add_parser("workspaces", help="GET /api/workspaces[?card_id=<id>]")
    p.add_argument("--card-id")

    p = sub.add_parser(
        "start",
        help="POST /api/workspaces/start -> 201 {workspace, session, run}. "
        "Repository scope is derived from the card's project (every linked "
        "repo: one worktree each on a shared branch). "
        "--branch is decoded but NOT forwarded by the server (known "
        "limitation — accepted here only for forward-compat).",
    )
    p.add_argument("--card-id", required=True)
    p.add_argument("--prompt-file", required=True)
    p.add_argument("--executor", required=True)
    p.add_argument(
        "--repo-id",
        help="deliberate operator-only pin of ONE repository — never pass "
        "this on a routine dispatch: on a multi-repo project it narrows the "
        "workspace to that single repo")
    p.add_argument("--branch", help="decoded but NOT forwarded by the server today")
    p.add_argument("--name")
    p.add_argument("--variant")
    p.add_argument("--model-id")
    p.add_argument("--permission-policy")

    p = sub.add_parser(
        "follow-up",
        help="POST /api/sessions/:id/follow-up — the resume channel for a "
        "parked agent. Returns 409 (as success:false, exit 1) when the "
        "session's latest run is still `running` — do not retry blindly.",
    )
    p.add_argument("session_id")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--prompt")
    g.add_argument("--prompt-file")
    p.add_argument("--executor", help="nil -> the session's stored executor")
    p.add_argument("--variant")
    p.add_argument("--model-id")
    p.add_argument("--permission-policy")

    p = sub.add_parser(
        "workspace-delete",
        help="DELETE /api/workspaces/:id — DESTRUCTIVE: force-removes the "
        "worktree, and any uncommitted work in it is gone with no undo. Only "
        "for a card that is done AND has corroborated delivery (a merged PR, "
        "or a `merge_commit: <sha>` line in the run's final report) AND whose "
        "latest run is terminal. Anything less: use `workspace-update "
        "--archived true`, which is reversible.",
    )
    p.add_argument("workspace_id")

    p = sub.add_parser(
        "workspace-update",
        help="PATCH /api/workspaces/:id — archive (or un-archive) a workspace. "
        "The reversible counterpart to `workspace-delete`: the worktree stays "
        "on disk, so this is the correct action whenever the delivery evidence "
        "is incomplete.",
    )
    p.add_argument("workspace_id")
    p.add_argument(
        "--archived", required=True, choices=["true", "false"],
        help="true to archive, false to restore")

    p = sub.add_parser(
        "send-input",
        help="POST /api/runs/:id/send-input — type into a LIVE headed agent's "
        "TUI. The only way to reach a headed run: it stays `running` for its "
        "whole tmux life, so a follow-up would 409 forever. Exit codes carry "
        "the meaning: 409 not_ready_for_input = mid-turn, retry later; 422 "
        "not_interactive = headless, use follow-up; 410 session_gone = the "
        "tmux session is gone, stop; 409 nudge_cap_reached = the host already "
        "nudged this run 3 times without progress and reported it, stop. Every "
        "stall nudge starts with `VC-NUDGE:`; use --nudge to send the "
        "host-composed one rather than writing your own.",
    )
    p.add_argument("run_id")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--text")
    g.add_argument("--text-file")
    g.add_argument(
        "--nudge", action="store_true",
        help="fetch the host-composed stall nudge (GET /api/runs/:id/nudge, "
        "starts with `VC-NUDGE:` and names the run's open items) and send it "
        "verbatim. Exits non-zero with nudge_cap_reached, sending nothing, "
        "once the host's 3-nudge cap holds.")

    p = sub.add_parser(
        "nudge-text",
        help="GET /api/runs/:id/nudge — the host-composed stall nudge for a "
        "run, as JSON {text, nudges_sent, cap, cap_reached, open_items}. "
        "Read-only: fetching never counts as a nudge. Send `text` verbatim "
        "(e.g. over host-messages); never compose your own.",
    )
    p.add_argument("run_id")

    p = sub.add_parser(
        "pane",
        help="GET /api/runs/:id/pane — what a headed agent's screen shows right "
        "now. Answers what no API field can: whether it is sitting on a modal "
        "the board cannot see. Returns 200 with `alive: false` for a dead "
        "session (that IS the answer, not an error).",
    )
    p.add_argument("run_id")
    p.add_argument("--lines", type=int, help="trim to the last N rendered lines")

    p = sub.add_parser(
        "agent-activity",
        help="GET /api/agent-activity — one-shot snapshot of every tracked "
        "workspace, including `last_activity_at`. The curl-able twin of the SSE "
        "stream; use it to see who has gone quiet.",
    )

    p = sub.add_parser("sessions", help="GET /api/workspaces/:id/sessions")
    p.add_argument("workspace_id")

    p = sub.add_parser("runs", help="GET /api/sessions/:id/runs (ordered; last = latest)")
    p.add_argument("session_id")

    p = sub.add_parser(
        "run",
        help="GET /api/runs/:id -> {run, final_message?, pending_approvals_count}. "
        "The primary progress/park/completion poll.",
    )
    p.add_argument("run_id")

    p = sub.add_parser(
        "run-logs",
        help="GET /api/runs/:id/logs — the run's log rows as ONE JSON payload "
        "(a tail: ?limit= rows, default 500, in insertion order) plus "
        "total/returned counts. The one-shot diagnostics read; "
        "total > returned means the run holds more rows than shown.",
    )
    p.add_argument("run_id")
    p.add_argument("--limit", type=int, help="tail length (default 500, server caps at 5000)")

    p = sub.add_parser("stop", help="POST /api/runs/:id/stop — no body.")
    p.add_argument("run_id")

    # -- approvals + git delivery ops (slice 4) ------------------------------
    p = sub.add_parser(
        "approvals-pending",
        help="GET /api/approvals/pending (global) or "
        "/api/approvals/pending/:run_id (per-run) with an arg.",
    )
    p.add_argument("run_id", nargs="?", default=None)

    p = sub.add_parser(
        "approval-respond",
        help="POST /api/approvals/:approval_id/respond — the body MUST carry "
        "execution_process_id (non-optional) and a nested status object "
        "(ApprovalOutcome), never a bare status string.",
    )
    p.add_argument("approval_id")
    p.add_argument("--execution-process-id", required=True, help="the run id (required)")
    p.add_argument("--status", required=True, choices=["approved", "denied", "answered"])
    p.add_argument("--reason", help="only valid with --status denied")
    p.add_argument(
        "--answers-json",
        help='required with --status answered: a JSON array of '
        '{"question": "...", "answer": ["label", ...]}',
    )

    p = sub.add_parser("merge", help="POST /api/workspaces/:id/merge — always sends a JSON object body.")
    p.add_argument("workspace_id")
    p.add_argument("--repo-id")
    p.add_argument("--message")

    p = sub.add_parser(
        "rebase",
        help="POST /api/workspaces/:id/rebase — always sends a JSON object "
        "body. Returns {status:clean, head} (200) or {status:conflict, "
        "conflicted_files} as a 409 WITH success:true (printed as data, exit 0).",
    )
    p.add_argument("workspace_id")
    p.add_argument("--repo-id")

    p = sub.add_parser("push", help="POST /api/workspaces/:id/push — always sends a JSON object body.")
    p.add_argument("workspace_id")
    p.add_argument("--repo-id")
    p.add_argument("--remote")
    p.add_argument("--remote-url")
    p.add_argument("--force", action="store_true")

    p = sub.add_parser(
        "workspace-repos",
        help="GET /api/workspaces/:id/repos — one entry per repo the "
        "workspace spans: working/target branch, ahead/behind vs target and "
        "upstream, uncommitted/untracked counts, conflict state. The read "
        "that grounds a commit/push/discard decision.")
    p.add_argument("workspace_id")

    p = sub.add_parser(
        "commit",
        help="POST /api/workspaces/:id/commit — git add -A + git commit in "
        "the workspace's worktree (save the working tree's changes). "
        "Returns {committed: true}, or {committed: false} when the tree was "
        "already clean (no-op success).")
    p.add_argument("workspace_id")
    p.add_argument("--repo-id", help="required on a multi-repo workspace")
    p.add_argument("--message", help="commit message (default: 'Workspace changes')")

    p = sub.add_parser(
        "discard",
        help="POST /api/workspaces/:id/discard — clean the working tree: "
        "git restore . + git clean -fd. DESTRUCTIVE and irreversible: "
        "uncommitted changes are lost and untracked files removed (ignored "
        "files preserved). Read workspace-repos first and name what will go.")
    p.add_argument("workspace_id")
    p.add_argument("--repo-id", help="required on a multi-repo workspace")

    p = sub.add_parser("pr", help="POST /api/workspaces/:id/pr -> 201. Always sends a JSON object body.")
    p.add_argument("workspace_id")
    p.add_argument("--repo-id")
    p.add_argument("--title")
    p.add_argument("--body")
    p.add_argument("--target-branch")

    p = sub.add_parser(
        "merge-record",
        help="POST /api/workspaces/:id/merge-record — records an "
        "already-performed merge; performs nothing, idempotent per "
        "workspace/repo/sha. The sha must resolve to a commit in the repo "
        "(else 422, nothing recorded; fetch first if it merged remotely) and "
        "is stored as the full 40-hex sha. Always sends a JSON object body.",
    )
    p.add_argument("workspace_id")
    p.add_argument("--sha", required=True, help="the merge commit sha (wire key merge_commit)")
    p.add_argument("--repo-id", help="required on a multi-repo workspace")
    p.add_argument("--target", help="target branch override (wire key target_branch)")
    p.add_argument("--message")

    p = sub.add_parser(
        "merge-record-retract",
        help="POST /api/workspaces/:id/merge-record/retract — removes a BAD "
        "merge record and prints the deleted row. merge_commit is matched "
        "exactly (no prefix matching; 404 if no row). Allowed only when the "
        "sha does not resolve, is not on the row's target branch, or "
        "duplicates another row for the same card/repo; a valid delivery "
        "record is refused with 409. Performs nothing in git.",
    )
    p.add_argument("workspace_id")
    p.add_argument("--merge-commit", "--sha", dest="sha", required=True,
                   help="the stored merge_commit, exactly as recorded")
    p.add_argument("--repo-id", help="required on a multi-repo workspace")

    p = sub.add_parser(
        "pr-record",
        help="POST /api/workspaces/:id/pr-record — records an already-opened "
        "PR; performs nothing, idempotent per workspace/repo/number. Always "
        "sends a JSON object body.",
    )
    p.add_argument("workspace_id")
    p.add_argument("--number", required=True, type=int)
    p.add_argument("--url", required=True)
    p.add_argument("--status")
    p.add_argument("--repo-id", help="required on a multi-repo workspace")
    p.add_argument("--title")

    p = sub.add_parser(
        "pr-merge",
        help="POST /api/workspaces/:id/pr-merge — merge the workspace's pull "
        "request THROUGH GitHub (`gh pr merge` / the REST merge), the "
        "selectable alternative to the local squash `merge` above. Records "
        "the resulting sha in `merges` exactly as merge-record does, so the "
        "shipping report is identical in shape, and flips the PR row to "
        "merged so the board and GitHub cannot disagree. Requires `gh auth` "
        "(or a GH_TOKEN) — see `doctor`, row tool.gh.",
    )
    p.add_argument("workspace_id")
    p.add_argument("--repo-id", help="required on a multi-repo workspace")
    p.add_argument("--number", type=int,
                   help="PR number (default: the workspace's newest open PR)")
    p.add_argument("--method", choices=["squash", "merge", "rebase"], default=None,
                   help="GitHub merge strategy (default: squash)")
    p.add_argument("--delete-branch", action="store_true",
                   help="delete the head branch after a successful merge")

    p = sub.add_parser(
        "review-ingest",
        help="POST /api/workspaces/:id/review-ingest — pull this workspace's "
        "PR review comments onto its card NOW instead of waiting out the "
        "background poll. Idempotent: `ingested` counts only comments the "
        "card did not already carry, so a second call returns 0. Ingested "
        "comments are attributed to their GitHub author "
        "(author_kind: github, author_label: the login).",
    )
    p.add_argument("workspace_id")

    p = sub.add_parser(
        "github-import",
        help="POST /api/projects/:id/github-import — one-shot GitHub Issues "
        "-> cards import. One card per issue; every label becomes a tag "
        "VERBATIM (matched case-insensitively against the board's existing "
        "tags, nothing dropped). Re-runnable: issues already imported come "
        "back in `skipped`, never as a second card.",
    )
    p.add_argument("project_id")
    p.add_argument("--repo", help="owner/name or a github.com remote URL "
                   "(default: derived from the board's repos' origin remotes)")
    p.add_argument("--state", choices=["open", "closed", "all"], default=None,
                   help="which issues to import (default: open)")
    p.add_argument("--limit", type=int, help="how many issues to ask for (default: 50)")
    p.add_argument("--status", help="board column the new cards land in (default: todo)")

    p = sub.add_parser(
        "issue-create",
        help="POST /api/issues — file an issue on VibeCrew's public tracker "
        "(dexloom/vibecrew_sh; the repo is pinned server-side, never chosen "
        "by the caller). Returns {number, url, repository}.",
    )
    p.add_argument("--title", required=True)
    p.add_argument("--body")
    p.add_argument("--label", action="append", dest="labels",
                   help="issue label; repeat the flag for multiple labels")

    return parser


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    base = resolve_base_url()
    cmd = args.subcommand

    if cmd == "health":
        payload = probe_health(base, for_health_subcommand=True)
        print(json.dumps(payload, indent=2))
        sys.exit(0)

    if cmd == "config":
        call(base, "GET", "/api/config")
        return
    if cmd == "doctor":
        doctor(base, as_text=args.text, failing_only=args.failing)
        return
    if cmd == "pipelines":
        call(base, "GET", "/api/pipelines")
        return
    if cmd == "pipeline":
        call(base, "GET", build_path("api", "pipelines", args.name))
        return
    if cmd == "pipeline-put":
        if args.toml is not None:
            toml_text = args.toml
        elif args.file not in (None, "-"):
            try:
                toml_text = Path(args.file).read_text(encoding="utf-8")
            except OSError as e:
                print(f"cannot read --file: {e}", file=sys.stderr)
                sys.exit(2)
        else:
            toml_text = sys.stdin.read()
        call(base, "PUT", build_path("api", "pipelines", args.name),
             body={"toml": toml_text})
        return
    if cmd == "pipeline-compose":
        enabled = [sid.strip() for sid in args.enabled_ids.split(",") if sid.strip()]
        if not enabled:
            print("--enabled-ids needs at least one stage id", file=sys.stderr)
            sys.exit(2)
        body = {"enabled_ids": enabled}
        if args.executor is not None:
            body["executor"] = args.executor
        if args.model is not None:
            body["model"] = args.model
        stage_agents = parse_stage_pairs(args.stage_agent, "--stage-agent")
        if stage_agents:
            body["stage_agents"] = stage_agents
        stage_models = parse_stage_pairs(args.stage_model, "--stage-model")
        if stage_models:
            body["stage_models"] = stage_models
        if args.custom_text is not None:
            body["custom_text"] = args.custom_text
        call(base, "POST", build_path("api", "pipelines", args.name, "compose"),
             body=body)
        return
    if cmd == "knowledge-ask":
        probe_health(base)
        query = {"q": args.question}
        if args.library:
            query["library"] = args.library
        if args.limit:
            query["limit"] = str(args.limit)
        if args.project:
            query["project"] = args.project
        status, raw = request(base, "GET", "/api/knowledge/ask", query=query)
        if not args.text:
            unwrap(raw)
            return
        # `--text` prints what the deterministic answer already is: the
        # citations, rendered. It never composes prose of its own — the whole
        # point of the endpoint is that nothing between the sources and the
        # reader is free to invent.
        try:
            envelope = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            unwrap(raw)
            return
        data = envelope.get("data") if envelope.get("success") is True else None
        if not isinstance(data, dict):
            unwrap(raw)
            return
        print(data.get("answer", ""))
        if data.get("handbook_index_stale"):
            print(
                "\n[handbook INDEX.md carries no vibecrew-handbook-index-v1 block "
                "— regenerate with scripts/generate-handbook-index.py and deploy it]"
            )
        return

    if cmd == "projects":
        call(base, "GET", "/api/projects")
        return
    if cmd == "repos":
        call(base, "GET", "/api/repos")
        return

    if cmd == "cards":
        probe_health(base)
        status, raw = request(base, "GET", "/api/cards", query={"project_id": args.project_id})
        if args.status:
            try:
                envelope = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                unwrap(raw)
                return
            if envelope.get("success") is True and isinstance(envelope.get("data"), list):
                filtered = [c for c in envelope["data"] if c.get("status") == args.status]
                envelope["data"] = filtered
                raw = json.dumps(envelope).encode("utf-8")
        unwrap(raw)
        return

    if cmd == "card":
        call(base, "GET", build_path("api", "cards", args.card_id))
        return

    if cmd == "stages":
        card_stages(base, args.card_id, stage_id=args.stage, as_text=args.text)
        return

    if cmd == "card-create":
        body = {"project_id": args.project_id, "title": args.title}
        description = read_description(args)
        if description is not None:
            body["description"] = description
        if args.priority is not None:
            body["priority"] = args.priority
        if args.status is not None:
            body["status"] = args.status
        if args.position is not None:
            body["position"] = args.position
        if args.parent_card_id is not None:
            body["parent_card_id"] = args.parent_card_id
        if args.parent_position is not None:
            body["parent_position"] = args.parent_position
        call(base, "POST", "/api/cards", body=body)
        return

    if cmd == "card-update":
        body = {}
        if args.title is not None:
            body["title"] = args.title
        description = read_description(args)
        if description is not None:
            body["description"] = description
        if args.status is not None:
            body["status"] = args.status
        if args.priority is not None:
            body["priority"] = args.priority
        if args.position is not None:
            body["position"] = args.position
        if args.parent_card_id is not None:
            body["parent_card_id"] = args.parent_card_id
        if args.parent_position is not None:
            body["parent_position"] = args.parent_position
        extension_metadata = read_extension_metadata(args)
        if extension_metadata is not None:
            body["extension_metadata"] = extension_metadata
        if args.clear_extension_metadata:
            body["clear_extension_metadata"] = True
        call(base, "PATCH", build_path("api", "cards", args.card_id), body=body)
        return

    if cmd == "workspace-delete":
        call(base, "DELETE", build_path("api", "workspaces", args.workspace_id))
        return

    if cmd == "workspace-update":
        call(base, "PATCH", build_path("api", "workspaces", args.workspace_id),
             body={"archived": args.archived == "true"})
        return

    if cmd == "send-input":
        if args.nudge:
            text = fetch_nudge_text(base, args.run_id)
        elif args.text is not None:
            text = args.text
        else:
            with open(args.text_file, "r", encoding="utf-8") as handle:
                text = handle.read()
        call(base, "POST", build_path("api", "runs", args.run_id, "send-input"),
             body={"text": text})
        return

    if cmd == "nudge-text":
        call(base, "GET", build_path("api", "runs", args.run_id, "nudge"))
        return

    if cmd == "pane":
        query = {"lines": str(args.lines)} if args.lines else None
        call(base, "GET", build_path("api", "runs", args.run_id, "pane"), query=query)
        return

    if cmd == "agent-activity":
        call(base, "GET", "/api/agent-activity")
        return

    if cmd == "card-prs":
        call(base, "GET", build_path("api", "cards", args.card_id, "pull-requests"))
        return

    if cmd == "card-shipping-report":
        call(base, "GET", build_path("api", "cards", args.card_id, "shipping-report"))
        return

    if cmd == "card-relationships":
        call(base, "GET", build_path("api", "cards", args.card_id, "relationships"))
        return

    if cmd == "card-relate":
        body = {
            "related_card_id": args.related_card_id,
            "relationship_type": args.type,
        }
        call(base, "POST", build_path("api", "cards", args.card_id, "relationships"),
             body=body)
        return

    if cmd == "card-unrelate":
        call(base, "DELETE",
             build_path("api", "cards", args.card_id, "relationships",
                        args.relationship_id))
        return

    if cmd == "comments":
        call(base, "GET", build_path("api", "cards", args.card_id, "comments"))
        return

    if cmd == "comment":
        body = {"body": args.body, "author_kind": args.kind}
        if args.label is not None:
            body["author_label"] = args.label
        if args.run_id is not None:
            body["run_id"] = args.run_id
        call(base, "POST", build_path("api", "cards", args.card_id, "comments"),
             body=body)
        return

    if cmd == "card-audit":
        query = {"diff": "1"} if args.diff else None
        call(base, "GET", build_path("api", "cards", args.card_id, "audit"),
             query=query)
        return

    if cmd == "audit-unused-workspaces":
        call(base, "GET", "/api/audit/unused-workspaces")
        return

    if cmd == "auditor-ask":
        text = args.text
        if text is None:
            with open(args.text_file, "r", encoding="utf-8") as handle:
                text = handle.read()
        call(base, "POST", "/api/auditor/ask", body={"question": text})
        return

    if cmd == "card-message":
        text = args.text
        if text is None:
            with open(args.text_file, "r", encoding="utf-8") as handle:
                text = handle.read()
        call(
            base,
            "POST",
            "/api/host-messages",
            body={"target_kind": "card", "card_id": args.card_id, "text": text},
        )
        return

    if cmd == "workspaces":
        query = {"card_id": args.card_id} if args.card_id else None
        call(base, "GET", "/api/workspaces", query=query)
        return

    if cmd == "start":
        try:
            prompt_text = Path(args.prompt_file).read_text(encoding="utf-8")
        except OSError as e:
            print(f"cannot read --prompt-file: {e}", file=sys.stderr)
            sys.exit(2)
        body = {"card_id": args.card_id, "prompt": prompt_text, "executor": args.executor}
        if args.repo_id is not None:
            body["repo_id"] = args.repo_id
        if args.branch is not None:
            body["branch"] = args.branch
        if args.name is not None:
            body["name"] = args.name
        if args.variant is not None:
            body["variant"] = args.variant
        if args.model_id is not None:
            body["model_id"] = args.model_id
        if args.permission_policy is not None:
            body["permission_policy"] = args.permission_policy
        call(base, "POST", "/api/workspaces/start", body=body)
        return

    if cmd == "follow-up":
        if args.prompt_file:
            try:
                prompt_text = Path(args.prompt_file).read_text(encoding="utf-8")
            except OSError as e:
                print(f"cannot read --prompt-file: {e}", file=sys.stderr)
                sys.exit(2)
        else:
            prompt_text = args.prompt
        body = {"prompt": prompt_text}
        if args.executor is not None:
            body["executor"] = args.executor
        if args.variant is not None:
            body["variant"] = args.variant
        if args.model_id is not None:
            body["model_id"] = args.model_id
        if args.permission_policy is not None:
            body["permission_policy"] = args.permission_policy
        call(base, "POST", build_path("api", "sessions", args.session_id, "follow-up"), body=body)
        return

    if cmd == "sessions":
        call(base, "GET", build_path("api", "workspaces", args.workspace_id, "sessions"))
        return

    if cmd == "runs":
        call(base, "GET", build_path("api", "sessions", args.session_id, "runs"))
        return

    if cmd == "run":
        call(base, "GET", build_path("api", "runs", args.run_id))
        return

    if cmd == "run-logs":
        query = {"limit": str(args.limit)} if args.limit else None
        call(base, "GET", build_path("api", "runs", args.run_id, "logs"), query=query)
        return

    if cmd == "stop":
        probe_health(base)
        status, raw = request(base, "POST", build_path("api", "runs", args.run_id, "stop"), body=None)
        unwrap(raw)
        return

    if cmd == "approvals-pending":
        if args.run_id:
            call(base, "GET", build_path("api", "approvals", "pending", args.run_id))
        else:
            call(base, "GET", "/api/approvals/pending")
        return

    if cmd == "approval-respond":
        if args.reason is not None and args.status != "denied":
            parser.error("--reason is only valid with --status denied")
        if args.status == "answered" and not args.answers_json:
            parser.error("--answers-json is required with --status answered")
        answers = None
        if args.answers_json is not None:
            answers = parse_answers_json(args.answers_json)

        outcome = {"status": args.status}
        if args.status == "denied" and args.reason is not None:
            outcome["reason"] = args.reason
        if args.status == "answered":
            outcome["answers"] = answers

        body = {
            "execution_process_id": args.execution_process_id,
            "status": outcome,
        }
        call(base, "POST", build_path("api", "approvals", args.approval_id, "respond"), body=body)
        return

    if cmd == "merge":
        body = {}
        if args.repo_id is not None:
            body["repo_id"] = args.repo_id
        if args.message is not None:
            body["message"] = args.message
        call(base, "POST", build_path("api", "workspaces", args.workspace_id, "merge"), body=body)
        return

    if cmd == "rebase":
        body = {}
        if args.repo_id is not None:
            body["repo_id"] = args.repo_id
        call(base, "POST", build_path("api", "workspaces", args.workspace_id, "rebase"), body=body)
        return

    if cmd == "push":
        body = {}
        if args.repo_id is not None:
            body["repo_id"] = args.repo_id
        if args.remote is not None:
            body["remote"] = args.remote
        if args.remote_url is not None:
            body["remote_url"] = args.remote_url
        if args.force:
            body["force"] = True
        call(base, "POST", build_path("api", "workspaces", args.workspace_id, "push"), body=body)
        return

    if cmd == "workspace-repos":
        call(base, "GET", build_path("api", "workspaces", args.workspace_id, "repos"))
        return

    if cmd == "commit":
        body = {}
        if args.repo_id is not None:
            body["repo_id"] = args.repo_id
        if args.message is not None:
            body["message"] = args.message
        call(base, "POST", build_path("api", "workspaces", args.workspace_id, "commit"), body=body)
        return

    if cmd == "discard":
        body = {}
        if args.repo_id is not None:
            body["repo_id"] = args.repo_id
        call(base, "POST", build_path("api", "workspaces", args.workspace_id, "discard"), body=body)
        return

    if cmd == "pr":
        body = {}
        if args.repo_id is not None:
            body["repo_id"] = args.repo_id
        if args.title is not None:
            body["title"] = args.title
        if args.body is not None:
            body["body"] = args.body
        if args.target_branch is not None:
            body["target_branch"] = args.target_branch
        call(base, "POST", build_path("api", "workspaces", args.workspace_id, "pr"), body=body)
        return

    if cmd == "merge-record":
        body = {"merge_commit": args.sha}
        if args.repo_id is not None:
            body["repo_id"] = args.repo_id
        if args.target is not None:
            body["target_branch"] = args.target
        if args.message is not None:
            body["message"] = args.message
        call(base, "POST", build_path("api", "workspaces", args.workspace_id, "merge-record"),
             body=body)
        return

    if cmd == "merge-record-retract":
        body = {"merge_commit": args.sha}
        if args.repo_id is not None:
            body["repo_id"] = args.repo_id
        call(base, "POST",
             build_path("api", "workspaces", args.workspace_id, "merge-record", "retract"),
             body=body)
        return

    if cmd == "pr-record":
        body = {"number": args.number, "url": args.url}
        if args.status is not None:
            body["status"] = args.status
        if args.repo_id is not None:
            body["repo_id"] = args.repo_id
        if args.title is not None:
            body["title"] = args.title
        call(base, "POST", build_path("api", "workspaces", args.workspace_id, "pr-record"),
             body=body)
        return

    if cmd == "pr-merge":
        body = {}
        if args.repo_id is not None:
            body["repo_id"] = args.repo_id
        if args.number is not None:
            body["number"] = args.number
        if args.method is not None:
            body["method"] = args.method
        if args.delete_branch:
            body["delete_branch"] = True
        call(base, "POST", build_path("api", "workspaces", args.workspace_id, "pr-merge"),
             body=body)
        return

    if cmd == "review-ingest":
        call(base, "POST",
             build_path("api", "workspaces", args.workspace_id, "review-ingest"), body={})
        return

    if cmd == "github-import":
        body = {}
        if args.repo is not None:
            body["repo"] = args.repo
        if args.state is not None:
            body["state"] = args.state
        if args.limit is not None:
            body["limit"] = args.limit
        if args.status is not None:
            body["status"] = args.status
        call(base, "POST", build_path("api", "projects", args.project_id, "github-import"),
             body=body)
        return

    if cmd == "issue-create":
        body = {"title": args.title}
        if args.body is not None:
            body["body"] = args.body
        if args.labels:
            body["labels"] = args.labels
        call(base, "POST", "/api/issues", body=body)
        return

    parser.error(f"unknown subcommand: {cmd}")


if __name__ == "__main__":
    main()
