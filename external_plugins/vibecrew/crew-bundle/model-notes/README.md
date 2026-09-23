# Model notes: per-family prompt overlays

Every VibeCrew agent and skill has one family-neutral base prompt. The files
here are short overlays, one per model family, that hold only the lines where a
family's official prompting guide differs from that base. At launch the app
picks the overlay from the model the run actually uses and appends it (Claude:
`--append-system-prompt-file`; Codex: `developer_instructions`; OpenCode and Pi:
the first message). A stage delegated inside a running agent gets the overlay's
absolute path in its delegation message instead. The app reads these files
straight from the synced catalog checkout; they are not manifest entries.

## Families

The app splits the model id on `/ - . _ :` and matches a whole token,
case-insensitively. `ModelFamily` in CrewLaunch owns the table.

| File | Token | Tuned for |
|---|---|---|
| `claude-opus.md` | `opus` | `claude-opus-5-5` |
| `claude-fable.md` | `fable` | `claude-fable-5-1` |
| `claude-sonnet.md` | `sonnet` | `claude-sonnet-5` |
| `gpt-sol.md` | `sol` | `gpt-6-sol` |
| `gpt-terra.md` | `terra` | `gpt-5.6-terra` |

Any other model gets the base prompt and no overlay.

## File contract (the Swift parser depends on it)

- Frontmatter: `family`, `tuned-for` (the exact latest model id), `reviewed`
  (a date), and `sources` (the official guide URLs, one per `  - ` line).
- The body is split on these four `## ` headings and no others:
  - `## All roles`: every run on the family.
  - `## Unattended roles`: added for the orchestrator and the pipeline
    product / planner / coder / reviewer stages. Autonomy openers and
    early-stop lines go here, never in `## All roles`.
  - `## Reviewer role`: added for review stages.
  - `## When effort is low`: added when the run's effort is `low`.
- A family may omit any section. `### ` headings inside a section are fine.
- Keep the body to 20–40 lines of plain second-person instructions. No bold for
  emphasis, no all-caps words, and no instruction to reveal, explain or show
  reasoning (Claude models decline those with the `reasoning_extraction`
  refusal).
- Overlays tune working habits. They never override an agent's constraints,
  output contract or marker strings; every base agent body says so.

## Keeping them current

When a vendor ships a new version in a family, retune that family's file against
the new official guide and bump `tuned-for` and `reviewed`. Base prompts and the
Swift code stay as they are. A new family means one row in `ModelFamily`, one
file here, and one test row.
