---
name: codex-review-plan
description: >
  Launch Codex CLI to review a Claude Code implementation plan for completeness, correctness, and potential issues.
  Use when a plan is ready for approval before implementation. Trigger when the user says "review the plan",
  "approve the plan", "codex review plan", "check the plan", or after plan mode produces a plan.
---

Review a Claude Code plan using Codex CLI for an independent second opinion before implementation begins.

Arguments: `[plan-file-name]` — specific plan file to review (optional, defaults to most recent)

## Process

1. **Locate the plan:**
   - If an argument is provided, use it as the plan filename: `~/.claude/plans/<argument>`
   - Otherwise, find the most recent plan: `ls -t ~/.claude/plans/ | head -1`
   - Read the plan file content

2. **Gather project context:**
   - Read `CLAUDE.md` for architectural guidelines and conventions
   - Run `git diff main --stat` to understand current branch scope (if any changes exist)

3. **Launch Codex review:**
   - Write the plan content to a temp file so Codex can read it
   - Run Codex in exec mode:

   ```bash
   PLAN_PATH="$HOME/.claude/plans/<plan-file>"
   codex exec --sandbox read-only "Review this implementation plan before I start coding. Read the plan at $PLAN_PATH and the project guidelines at ./CLAUDE.md.

   Review for:
   1. COMPLETENESS: Does the plan cover all necessary changes? Missing migrations, tests, error handling?
   2. ARCHITECTURE: Does it follow the project's patterns from CLAUDE.md?
   3. RISKS: Race conditions, breaking changes, edge cases, performance concerns?
   4. ORDER OF OPERATIONS: Are the steps in the right sequence? Dependencies respected?
   5. SCOPE CREEP: Is anything unnecessary or over-engineered for what's being solved?

   Give a verdict: APPROVED / NEEDS CHANGES / REJECTED
   APPROVED means no Critical or Important findings remain (Minor findings are acceptable).
   List specific issues by severity (Critical / Important / Minor).
   For each issue, reference the specific section of the plan."
   ```

4. **Process results and iterate:**
   - Parse the Codex verdict and findings
   - If **APPROVED** (no Critical/Important findings): report approval and confirm the plan is ready for implementation
   - If **NEEDS CHANGES** or **REJECTED** (Critical or Important findings exist):
     a. Present all findings to the user
     b. Apply fixes to the plan file based on the findings
     c. Re-run Codex review (step 3) on the updated plan
     d. Repeat until verdict is APPROVED (only Minor findings remain)

## Notes

- This is read-only for Codex (--sandbox read-only) — Codex cannot modify files
- Between review iterations, Claude (not Codex) applies fixes to the plan based on findings
- Codex provides a fresh independent perspective on the plan
- If Codex is not installed, fall back to performing the review inline using the same criteria
