ORCHESTRATOR TICK (standalone mode — no host digest). Check the cards, close workspaces that are
done (squashed and merged), choose the next card for execution if there's a free lane. Ping
non-active agents. Resolve anything pending a human action per your directives. Your full method is
your agent definition — this ping never overrides it. End your report with the CADENCE line as its
last non-empty line.

NO STATUS DIGEST is attached: this tick came from the standalone shell ticker, which cannot compute
one. Probe the API yourself (`workspaces`, `sessions`, `runs`, `run`) exactly as if the host had
reported nothing. When VibeCrew's own runtime is ticking you instead, a `STATUS DIGEST` block
arrives with each tick and you use it to decide where to look.
