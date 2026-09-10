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
# agents/decider.md, agents/auditor.md, agents/pm.md, or the
# agents-opencode/ / agents-codex/ twins change — or whenever the
# product-manager / classify-task SKILLs change (their standalone copies
# ride along) — then bump the changed entry's `version` in
# crew-bundle/manifest.json
# so installed copies show "Update available" after the app syncs.
#
# Usage:
#   scripts/sync-crew-bundle.sh   (from external_plugins/vibecrew)
set -euo pipefail

cd "$(dirname "$0")/.."
BUNDLE="crew-bundle"

mkdir -p "${BUNDLE}/vibecrew-orchestrator/claude" \
         "${BUNDLE}/vibecrew-orchestrator/opencode" \
         "${BUNDLE}/vibecrew-orchestrator/codex" \
         "${BUNDLE}/vibecrew-decider/claude" \
         "${BUNDLE}/vibecrew-assistant/claude" \
         "${BUNDLE}/vibecrew-assistant/opencode" \
         "${BUNDLE}/vibecrew-assistant/codex" \
         "${BUNDLE}/vibecrew-auditor/claude" \
         "${BUNDLE}/vibecrew-auditor/opencode" \
         "${BUNDLE}/vibecrew-auditor/codex" \
         "${BUNDLE}/vibecrew-pm/claude" \
         "${BUNDLE}/vibecrew-pm/opencode" \
         "${BUNDLE}/vibecrew-pm/codex" \
         "${BUNDLE}/product-manager/claude" \
         "${BUNDLE}/product-manager/opencode" \
         "${BUNDLE}/classify-task/claude" \
         "${BUNDLE}/classify-task/opencode"

cp agents/orchestrator.md              "${BUNDLE}/vibecrew-orchestrator/claude/agent.md"
cp agents-opencode/vc-orchestrator.md  "${BUNDLE}/vibecrew-orchestrator/opencode/agent.md"
cp agents/decider.md                   "${BUNDLE}/vibecrew-decider/claude/agent.md"
cp agents/assistant.md                 "${BUNDLE}/vibecrew-assistant/claude/agent.md"
cp agents-opencode/va-assistant.md     "${BUNDLE}/vibecrew-assistant/opencode/agent.md"
cp agents/auditor.md                   "${BUNDLE}/vibecrew-auditor/claude/agent.md"
cp agents-opencode/va-auditor.md       "${BUNDLE}/vibecrew-auditor/opencode/agent.md"
cp agents-codex/vc-orchestrator.md     "${BUNDLE}/vibecrew-orchestrator/codex/agent.md"
cp agents-codex/va-assistant.md        "${BUNDLE}/vibecrew-assistant/codex/agent.md"
cp agents-codex/va-auditor.md          "${BUNDLE}/vibecrew-auditor/codex/agent.md"
cp agents/pm.md                        "${BUNDLE}/vibecrew-pm/claude/agent.md"
cp agents-opencode/vp-pm.md            "${BUNDLE}/vibecrew-pm/opencode/agent.md"
cp agents-codex/vp-pm.md               "${BUNDLE}/vibecrew-pm/codex/agent.md"

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
/usr/bin/sed -i '' '1,10s/^name: pm$/name: vibecrew-pm/' \
  "${BUNDLE}/vibecrew-pm/claude/agent.md"
# The codex copies carry the same `name:` field, for the same reason: VibeCrew
# reads the installed file by id and hands the body to the CLI as
# `-c developer_instructions=<body>`, and the contract test asserts the
# declared name matches the id it was installed under.
/usr/bin/sed -i '' '1,10s/^name: orchestrator$/name: vibecrew-orchestrator/' \
  "${BUNDLE}/vibecrew-orchestrator/codex/agent.md"
/usr/bin/sed -i '' '1,10s/^name: assistant$/name: vibecrew-assistant/' \
  "${BUNDLE}/vibecrew-assistant/codex/agent.md"
/usr/bin/sed -i '' '1,10s/^name: auditor$/name: vibecrew-auditor/' \
  "${BUNDLE}/vibecrew-auditor/codex/agent.md"
/usr/bin/sed -i '' '1,10s/^name: pm$/name: vibecrew-pm/' \
  "${BUNDLE}/vibecrew-pm/codex/agent.md"

# The Product Skills ship as standalone SKILL copies so the app can install
# the PM agent's method wherever it launches. Two rewrites, both because the
# standalone install has no plugin root:
#   1. the bundled API client resolves from the app's managed checkout of
#      THIS repo (always present when an install succeeded — the catalog is
#      read from it), not ${CLAUDE_PLUGIN_ROOT};
#   2. sibling skills are named WITHOUT the `vibecrew:` plugin prefix.
for SKILL in product-manager classify-task; do
  for CLI in claude opencode; do
    cp "skills/${SKILL}/SKILL.md" "${BUNDLE}/${SKILL}/${CLI}/SKILL.md"
    /usr/bin/sed -i '' \
      -e 's|\${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py|~/.vibecrew/plugins/external_plugins/vibecrew/scripts/vibecrew_api.py|g' \
      -e 's|\${CLAUDE_PLUGIN_ROOT}/skills/vibecrew/SKILL.md|~/.vibecrew/plugins/external_plugins/vibecrew/skills/vibecrew/SKILL.md|g' \
      -e 's|vibecrew:vibecrew|vibecrew|g' \
      -e 's|vibecrew:classify-task|classify-task|g' \
      -e 's|vibecrew:product-manager|product-manager|g' \
      -e 's|vibecrew:answer-questions|answer-questions|g' \
      "${BUNDLE}/${SKILL}/${CLI}/SKILL.md"
  done
done

echo "Refreshed standalone copies in ${BUNDLE}"
echo
echo "SHA-256:"
shasum -a 256 "${BUNDLE}/vibecrew-orchestrator/claude/agent.md" \
              "${BUNDLE}/vibecrew-orchestrator/opencode/agent.md" \
              "${BUNDLE}/vibecrew-decider/claude/agent.md" \
              "${BUNDLE}/vibecrew-assistant/claude/agent.md" \
              "${BUNDLE}/vibecrew-assistant/opencode/agent.md" \
              "${BUNDLE}/vibecrew-auditor/claude/agent.md" \
              "${BUNDLE}/vibecrew-auditor/opencode/agent.md" \
              "${BUNDLE}/vibecrew-orchestrator/codex/agent.md" \
              "${BUNDLE}/vibecrew-assistant/codex/agent.md" \
              "${BUNDLE}/vibecrew-auditor/codex/agent.md" \
              "${BUNDLE}/vibecrew-pm/claude/agent.md" \
              "${BUNDLE}/vibecrew-pm/opencode/agent.md" \
              "${BUNDLE}/vibecrew-pm/codex/agent.md" \
              "${BUNDLE}/product-manager/claude/SKILL.md" \
              "${BUNDLE}/product-manager/opencode/SKILL.md" \
              "${BUNDLE}/classify-task/claude/SKILL.md" \
              "${BUNDLE}/classify-task/opencode/SKILL.md"
echo
echo "Contract version lines:"
grep -m1 'VC-ORCH-CONTRACT' "${BUNDLE}/vibecrew-orchestrator/claude/agent.md" || echo "  (orchestrator missing!)"
grep -m1 'VC-ASSIST-CONTRACT' "${BUNDLE}/vibecrew-assistant/claude/agent.md" || echo "  (assistant missing!)"
grep -m1 'VC-AUDIT-CONTRACT' "${BUNDLE}/vibecrew-auditor/claude/agent.md" || echo "  (auditor missing!)"
grep -m1 'VC-PM-CONTRACT' "${BUNDLE}/vibecrew-pm/claude/agent.md" || echo "  (pm missing!)"
grep -m1 'VC-ORCH-CONTRACT' "${BUNDLE}/vibecrew-orchestrator/codex/agent.md" || echo "  (codex orchestrator missing!)"
grep -m1 'VC-ASSIST-CONTRACT' "${BUNDLE}/vibecrew-assistant/codex/agent.md" || echo "  (codex assistant missing!)"
grep -m1 'VC-AUDIT-CONTRACT' "${BUNDLE}/vibecrew-auditor/codex/agent.md" || echo "  (codex auditor missing!)"
grep -m1 'VC-PM-CONTRACT' "${BUNDLE}/vibecrew-pm/codex/agent.md" || echo "  (codex pm missing!)"
echo "Standalone skill copies are plugin-root-free:"
grep -rl 'CLAUDE_PLUGIN_ROOT' "${BUNDLE}/product-manager" "${BUNDLE}/classify-task" && echo "  (PLUGIN_ROOT LEAK!)" || echo "  (clean)"
