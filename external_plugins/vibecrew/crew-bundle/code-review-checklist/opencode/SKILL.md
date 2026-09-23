---
name: code-review-checklist
description: Runs a focused self-review over a code change before a PR is opened and reports every issue found, grouped by severity and cited at file:line. Use when the user says "review my change", "self-review this", "check this before I commit", or before opening a pull request.
tools: Read, Grep, Glob, Bash
---

# Code Review Checklist

Review the current change (the staged diff or `target..HEAD`) and report findings before a PR is opened. The user's instructions take precedence over this skill.

## Steps

1. Get the diff: `git diff` for staged changes, else `git diff target...HEAD`. If the range is ambiguous, ask which one to use.
2. Walk the checklist below against every touched hunk. Read independent files in parallel.
3. Report every issue you find, including ones you are unsure about or judge minor; the user decides what to act on. Then group the findings by severity: Blocking, Should fix, Nit. Cite each one as `file:line`. Propose fixes only when asked.

## Checklist

- Error handling: are thrown or returned errors handled? Is an optional force-unwrapped where nil is plausible?
- Edge cases: empty input, a single element, off-by-one, concurrent access, large input, unicode.
- Naming: do identifiers describe what the code does?
- Tests: does the change add or update tests, and do existing tests still cover the modified paths?
- Side effects: I/O, mutation of shared state, ordering dependencies.
- Public surface: did a signature, type, or persisted shape change in a way callers must adapt to?
- Dead code: unused imports, unreachable branches, commented-out blocks.

When the change is clean, say "No findings" explicitly; silence is not a verdict.
