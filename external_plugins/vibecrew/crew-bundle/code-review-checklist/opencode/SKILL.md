---
name: code-review-checklist
description: Run a focused self-review over a code change before opening a PR. Use when the user says "review my change", "self-review this", "check this before I commit", or before opening a pull request.
tools: Read, Grep, Glob, Bash
---

# Code Review Checklist

Perform a focused review of the current change (staged diff or `target..HEAD`)
and report findings before a PR is opened.

## Steps

1. Obtain the diff to review. Prefer `git diff` for staged changes, else
   `git diff target...HEAD`. If the scope is ambiguous, ask which range to use.
2. Walk the checklist below against every touched hunk.
3. Report findings grouped by severity: **Blocking**, **Should fix**, **Nit**.
   Cite each finding with `file:line`. Do not propose fixes unless asked.

## Checklist

- **Error handling:** are thrown/returned errors handled? Are optionals force-
  unwrapped where a nil is plausible?
- **Edge cases:** empty input, single-element, off-by-one, concurrent access,
  large input, unicode.
- **Naming:** do identifiers describe what the code does?
- **Tests:** does the change include or update tests? Do existing tests still
  cover the modified paths?
- **Side effects:** I/O, mutation of shared state, ordering dependencies.
- **Public surface:** did a signature, type, or persisted shape change in a
  way callers must adapt to?
- **Dead code:** unused imports, unreachable branches, commented-out blocks.

Report "No findings" explicitly when the change is clean — silence is not a
verdict.
