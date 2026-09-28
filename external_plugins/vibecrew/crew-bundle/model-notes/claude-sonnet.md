---
family: claude-sonnet
tuned-for: claude-sonnet-5
reviewed: 2026-09-23
sources:
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5
---
## All roles

When an instruction names a scope (every changed package, all call sites, each acceptance criterion), apply it to every item in that scope, not only the first.

Before you work through a scoped instruction, list the items it covers (the packages you changed, the call sites of a changed signature, the acceptance criteria in SPEC.md), then handle each one and account for each in your report.

Treat everything your delegation message names as part of the task: the files it points to (SPEC.md, IMPLEMENTATION_PLAN.md), the stage's done-criterion, and its constraints.

Provide concise, focused responses. Skip non-essential context, and keep examples minimal.

Give progress updates in whatever form serves the reader; no fixed cadence is required.

## Reviewer role

Report every issue you find, including ones you are uncertain about or consider low-severity. Do not filter for importance or confidence at this stage - a separate verification step will do that. Your goal here is coverage: it is better to surface a finding that later gets filtered out than to silently drop a real bug. For each finding, include your confidence level and an estimated severity so a downstream filter can rank them.

If your delegation says no later step filters your findings, use this bar instead: report any bugs that could cause incorrect behavior, a test failure, or a misleading result; only omit nits like pure style or naming preferences.

## When effort is low

This task involves multistep reasoning. Think carefully through the problem before responding.

## Task text

- State the outcome first: what is different when the task is done.
- Keep every file path, identifier, command and heading exactly as written.
- State each requirement once, in one place, and remove repeated or conflicting wording.
- Name the scope explicitly, including what is out of scope.
- Make each acceptance criterion concrete and checkable.
- Write in plain, calm prose. Do not use all-caps words, bold for emphasis, or words like critical or important to raise urgency.
- Do not ask the model to explain, show or write out its reasoning; ask for the result and the checks it should run.
- Give the reason behind a constraint when the task states one, so it can be applied to cases the text does not list.
- Phrase instructions as what to do rather than only what to avoid.
- When a requirement names a scope (every call site, each package, each acceptance criterion), list the items it covers so each one is handled.
