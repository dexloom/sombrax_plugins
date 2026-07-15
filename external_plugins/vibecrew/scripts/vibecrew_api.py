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

    # -- health / config / projects / repos (slice 1) -----------------------
    sub.add_parser("health", help="GET /health — the connectivity probe itself.")
    sub.add_parser("config", help="GET /api/config — the config.*-prefixed KV rows.")
    sub.add_parser("projects", help="GET /api/projects")
    sub.add_parser("repos", help="GET /api/repos — repo ids for `start --repo-id`.")

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

    p = sub.add_parser(
        "card-prs",
        help="GET /api/cards/:id/pull-requests — PullRequestRecords only "
        "(status defaults to open); the PR-delivery Done corroborator. Does "
        "NOT surface direct merges (no queryable record for those).",
    )
    p.add_argument("card_id")

    # -- workspaces / launch / runs (slice 3) --------------------------------
    p = sub.add_parser("workspaces", help="GET /api/workspaces[?card_id=<id>]")
    p.add_argument("--card-id")

    p = sub.add_parser(
        "start",
        help="POST /api/workspaces/start -> 201 {workspace, session, run}. "
        "--branch is decoded but NOT forwarded by the server (known "
        "limitation — accepted here only for forward-compat).",
    )
    p.add_argument("--card-id", required=True)
    p.add_argument("--prompt-file", required=True)
    p.add_argument("--executor", required=True)
    p.add_argument("--repo-id")
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

    p = sub.add_parser("pr", help="POST /api/workspaces/:id/pr -> 201. Always sends a JSON object body.")
    p.add_argument("workspace_id")
    p.add_argument("--repo-id")
    p.add_argument("--title")
    p.add_argument("--body")
    p.add_argument("--target-branch")

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
        call(base, "PATCH", build_path("api", "cards", args.card_id), body=body)
        return

    if cmd == "card-prs":
        call(base, "GET", build_path("api", "cards", args.card_id, "pull-requests"))
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

    parser.error(f"unknown subcommand: {cmd}")


if __name__ == "__main__":
    main()
