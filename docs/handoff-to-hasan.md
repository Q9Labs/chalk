# Handoff To Hasan

Use this when Hasan asks for a handoff, review map, or the recurring implementation-worker process.

## Implementation Workers

- For substantial implementation, prefer `gpt-5.5 high` workers.
- Give each worker clear scope, required docs, expected verification, commit expectations, and any constraints from the active project instructions.
- Poll workers patiently with long waits. Do not interrupt, duplicate their work, or take over unless the worker finishes, reports a blocker, asks for a decision, or Hasan redirects the task.
- After implementation, make the worker run the relevant focused gates, stage only intended paths, and create a conventional commit for its work when a commit is part of the requested flow.
- Make the worker run a Codex review on the commit, fix actionable findings, and repeat review/fix until clean or until only explicitly accepted residual risk remains.

## Hasan Review Map

After implementation, provide a short review map Hasan can quickly inspect in Zed. Keep it concrete and easy to open:

- What changed.
- Routes or behaviors added.
- Key files with clickable full paths and line numbers.
- Functions/types worth reading first.
- Concerns, tradeoffs, or open questions.
- What verification passed and what was skipped or blocked.

Do not redo the whole code review in prose. Point at the code paths that matter.
