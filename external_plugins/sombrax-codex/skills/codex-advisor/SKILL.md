---
name: codex-advisor
description: >
  Get architectural, algorithmic, or troubleshooting advice from Codex CLI as an independent second opinion.
  Use this skill PROACTIVELY when you feel uncertain about the best approach to a problem — you don't need
  to wait for the user to ask. Trigger when facing: architecture decisions (module boundaries, data flow,
  trait design), algorithm selection (data structure choice, complexity tradeoffs), debugging strategy
  (where to look, what to instrument), design tradeoffs (flexibility vs simplicity, performance vs readability),
  or any situation where multiple viable approaches exist and you're not confident which is best.
  Also trigger when the user asks "which approach", "how should I architect", "what's the best way to",
  "what strategy", "help me decide", "tradeoffs between". Do NOT use for compilation errors, syntax fixes,
  type errors, test failures, linting issues, or straightforward coding tasks where the solution is clear.
---

Get a second opinion from Codex CLI when you're uncertain about the best approach to a problem.

This skill exists because two heads are better than one. When you're weighing multiple approaches and aren't sure which is right, Codex can offer a fresh perspective grounded in the same codebase context. The goal isn't to outsource thinking — it's to reduce the risk of committing to an approach that turns out to be wrong, which wastes the user's time.

Arguments: `[question or context]` — optional inline description of what you need advice on

## When to Use This

Use this skill when you notice yourself hedging between approaches or when the user's request involves genuine design ambiguity. Some concrete signals:

- You're about to propose an architecture and realize there are 2-3 viable patterns
- The user asks "how should we structure this" and you're not sure of the best decomposition
- You're debugging something subtle and aren't sure where to look first
- A refactoring could go several directions and the tradeoffs aren't obvious
- You need to choose between algorithms/data structures with different performance characteristics
- The problem involves cross-cutting concerns (concurrency, error propagation, module boundaries)

Do NOT use this for:
- Fixing compiler errors or type mismatches (just fix them)
- Writing straightforward implementations where the approach is clear
- Syntax questions or API usage (read the docs instead)
- Test failures with obvious causes
- Simple refactors like renames or extract-function

## Process

1. **Frame the question clearly:**
   - What is the specific decision or uncertainty?
   - What approaches are you considering?
   - What are the constraints (performance, maintainability, compatibility)?
   - What does the relevant code look like right now?

2. **Gather context for Codex:**
   - Identify the key files Codex should read to understand the problem
   - Read CLAUDE.md for any relevant architectural guidelines
   - Note any constraints the user has mentioned

3. **Launch Codex for advice:**

   ```bash
   codex exec --sandbox read-only "I need architectural/design advice on the following problem.

   CONTEXT:
   <describe the current state — what exists, what the user wants, relevant file paths>

   QUESTION:
   <the specific decision or uncertainty>

   APPROACHES I'M CONSIDERING:
   <list the approaches you've thought of, if any>

   CONSTRAINTS:
   <performance requirements, compatibility needs, project conventions from CLAUDE.md, etc>

   Please:
   1. Read the relevant files to understand the current codebase structure
   2. Evaluate each approach (or suggest new ones) based on the actual code
   3. Recommend one approach with clear reasoning
   4. Flag any risks or gotchas with the recommended approach
   5. If the question is about debugging, suggest where to look first and why"
   ```

4. **Synthesize the advice:**
   - Read the Codex response
   - Evaluate whether the recommendation makes sense given what you know
   - If Codex suggests something you hadn't considered, think critically about it
   - Don't blindly follow — use it as input alongside your own analysis

5. **Present to the user:**
   - Share your recommendation (informed by Codex's input)
   - Briefly mention that you consulted Codex for a second opinion
   - Explain the tradeoffs so the user can make an informed decision
   - If you and Codex disagree, present both perspectives honestly

## Notes

- This uses read-only sandbox — Codex won't modify any files
- Keep the question focused. Broad questions like "how should I design everything" get vague answers. Specific questions like "should the cache live in the handler or in a shared middleware" get useful ones
- If Codex is not installed, fall back to reasoning through the tradeoffs yourself and being transparent with the user about your uncertainty
- You can invoke this multiple times for different aspects of the same problem — e.g., once for the data model design, once for the concurrency strategy
