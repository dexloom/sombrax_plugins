---
name: codex-review
description: >
  Run iterative code review with Codex CLI until no significant findings.
  Use this skill when the user wants a code review, asks to review changes, or says
  "review my code", "codex review", "run a review", "check my changes".
  Triggers on code review requests for any Rust or general codebase.
---

Run an iterative code review on the current branch using Codex CLI. Reviews changes against the base branch (default: main), fixes issues, and re-reviews until no significant findings remain.

Arguments: `[base-branch]` — the branch to diff against (default: main)

## Review Criteria

### Code Quality
- Correct logic and error handling
- No dead code or unused imports
- Proper resource cleanup (file handles, connections)
- No hardcoded values that should be configurable
- Appropriate logging and error messages

### Efficiency
- No unnecessary allocations or copies
- Efficient data structures for the use case
- Avoid N+1 queries or redundant operations
- Proper use of async/await patterns

### Consistency
- Follows existing code patterns in the codebase
- Consistent naming conventions (snake_case for functions, PascalCase for types)
- Consistent error handling approach
- Consistent module organization

### CLAUDE.md Compliance
- Read the project's CLAUDE.md and check all changes comply with its guidelines
- Check architectural patterns (e.g., three-layer data architecture, repository patterns)
- Check database usage patterns match project conventions
- Check shared state patterns (Arc<RwLock<T>> etc.)
- All I/O is async with tokio runtime

## Review Process

1. **Identify changes to review:**
   - Determine base branch (use argument if provided, otherwise "main")
   - Run `git log <base>..HEAD --oneline` to see commits
   - Run `git diff <base> --stat` to see changed files

2. **Run the first Codex review with criteria:**
   - Use `codex exec` (not `codex review`) so the session can be resumed cheaply for re-checks:
   ```bash
   codex exec --sandbox read-only "Review the diff of the current branch against the base branch <base-branch>. Run git diff <base-branch> yourself and read any changed files you need.

   Review for: code quality, efficiency, consistency with codebase patterns, and CLAUDE.md compliance. Check error handling, async patterns, data layer architecture, and database usage. Separate blockers (Critical/Important) from Minor findings and false positives." < /dev/null
   ```
   - The redirect `< /dev/null` is mandatory: `codex exec` reads stdin in addition to its prompt and blocks forever if left open.

3. **Analyze findings and categorize:**
   - Critical: Security vulnerabilities, data loss risks, breaking changes, CLAUDE.md violations
   - Important: Bugs, logic errors, performance problems, inconsistencies with codebase patterns
   - Minor/False Positive: Style preferences, subjective improvements, non-issues

4. **For Critical and Important findings:**
   - Read the relevant file and understand the issue
   - Implement the fix following CLAUDE.md guidelines
   - Explain what was fixed

5. **After fixing:**
   - Stage changes: `git add <fixed-files>`
   - Commit with message: "fix: address code review findings"
   - **Re-check by resuming the same Codex session** — do not start a fresh review. Codex already has the full context, so a short follow-up prompt costs a fraction of the tokens and time of a new review:
   ```bash
   codex exec resume --last "We fixed the findings: <one-line summary of each fix>. Re-run git diff <base-branch> on the updated code and verify each of your previous findings is resolved. Report only unresolved or newly introduced issues, by severity. If everything is resolved, say so explicitly." < /dev/null
   ```
   - Run `resume` from the same working directory as the first review (`--last` filters sessions by cwd).
   - If `resume` fails (session not found, CLI error), fall back to a fresh full review with the step-2 prompt.

6. **Repeat steps 3-5 until:**
   - Only Minor findings remain, OR
   - Remaining findings are false positives

7. **Final report:**
   - Summary of all fixes applied
   - List of remaining minor/false-positive findings (if any)
   - Confirmation that review cycle is complete
