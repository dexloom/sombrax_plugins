#!/usr/bin/env bash
#
# sync-crew-bundle.sh — refresh the STANDALONE agent copies in the crew-bundle
# (the catalog the VibeCrew app installs from its git checkout of this repo at
# ~/.vibecrew/plugins) from their plugin-side sources of truth, and print
# SHA-256 sums for eyeballing.
#
# Why two copies: inside the plugin the agents are namespaced
# (`vibecrew:orchestrator`, frontmatter `name: orchestrator`), so Claude Code
# resolves them per-plugin. The crew-bundle copies install STANDALONE into the
# CLI's global agents dir as `vibecrew-orchestrator.md`, and the app launches
# with `--agent vibecrew-orchestrator` — which resolves by the DECLARED name,
# not the filename. Left as-is, a default Claude launch simply cannot find it.
# Every catalog agent has name == plugin id; the rewrite below keeps that
# invariant.
#
# This is a DEV-TIME script — it is never run by the app or at install time.
# Run it whenever agents/orchestrator.md, agents/assistant.md,
# agents/decider.md, agents/auditor.md, or the agents-opencode/ twins
# change, then bump the changed agent's `version` in crew-bundle/manifest.json
# so installed copies show "Update available" after the app syncs.
#
# Usage:
#   scripts/sync-crew-bundle.sh   (from external_plugins/vibecrew)
set -euo pipefail

cd "$(dirname "$0")/.."
BUNDLE="crew-bundle"

mkdir -p "${BUNDLE}/vibecrew-orchestrator/claude" \
         "${BUNDLE}/vibecrew-orchestrator/opencode" \
         "${BUNDLE}/vibecrew-decider/claude" \
         "${BUNDLE}/vibecrew-assistant/claude" \
         "${BUNDLE}/vibecrew-assistant/opencode" \
         "${BUNDLE}/vibecrew-auditor/claude" \
         "${BUNDLE}/vibecrew-auditor/opencode"

cp agents/orchestrator.md              "${BUNDLE}/vibecrew-orchestrator/claude/agent.md"
cp agents-opencode/vc-orchestrator.md  "${BUNDLE}/vibecrew-orchestrator/opencode/agent.md"
cp agents/decider.md                   "${BUNDLE}/vibecrew-decider/claude/agent.md"
cp agents/assistant.md                 "${BUNDLE}/vibecrew-assistant/claude/agent.md"
cp agents-opencode/va-assistant.md     "${BUNDLE}/vibecrew-assistant/opencode/agent.md"
cp agents/auditor.md                   "${BUNDLE}/vibecrew-auditor/claude/agent.md"
cp agents-opencode/va-auditor.md       "${BUNDLE}/vibecrew-auditor/opencode/agent.md"

# The one field that CANNOT be copied verbatim (see header): rewrite the
# plugin-namespaced `name:` to the standalone id the app launches/delegates by.
/usr/bin/sed -i '' '1,10s/^name: orchestrator$/name: vibecrew-orchestrator/' \
  "${BUNDLE}/vibecrew-orchestrator/claude/agent.md"
/usr/bin/sed -i '' '1,10s/^name: decider$/name: vibecrew-decider/' \
  "${BUNDLE}/vibecrew-decider/claude/agent.md"
/usr/bin/sed -i '' '1,10s/^name: assistant$/name: vibecrew-assistant/' \
  "${BUNDLE}/vibecrew-assistant/claude/agent.md"
/usr/bin/sed -i '' '1,10s/^name: auditor$/name: vibecrew-auditor/' \
  "${BUNDLE}/vibecrew-auditor/claude/agent.md"

echo "Refreshed standalone copies in ${BUNDLE}"
echo
echo "SHA-256:"
shasum -a 256 "${BUNDLE}/vibecrew-orchestrator/claude/agent.md" \
              "${BUNDLE}/vibecrew-orchestrator/opencode/agent.md" \
              "${BUNDLE}/vibecrew-decider/claude/agent.md" \
              "${BUNDLE}/vibecrew-assistant/claude/agent.md" \
              "${BUNDLE}/vibecrew-assistant/opencode/agent.md" \
              "${BUNDLE}/vibecrew-auditor/claude/agent.md" \
              "${BUNDLE}/vibecrew-auditor/opencode/agent.md"
echo
echo "Contract version lines:"
grep -m1 'VC-ORCH-CONTRACT' "${BUNDLE}/vibecrew-orchestrator/claude/agent.md" || echo "  (orchestrator missing!)"
grep -m1 'VC-ASSIST-CONTRACT' "${BUNDLE}/vibecrew-assistant/claude/agent.md" || echo "  (assistant missing!)"
grep -m1 'VC-AUDIT-CONTRACT' "${BUNDLE}/vibecrew-auditor/claude/agent.md" || echo "  (auditor missing!)"
