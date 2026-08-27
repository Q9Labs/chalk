# History

Weekly digests of Chalk's session logs, one file per ISO week.

Each digest condenses that week's logs into the durable conclusions: decisions
and why they were made, defects and their root causes, contracts that were
settled, and limits that were accepted. Verification transcripts, timestamps,
and per-run command output are not carried forward — they live in git history
with the originals.

Every digest ends with an index naming each original log it covers, so any entry
can be recovered:

```
git log --diff-filter=D --name-only -- 'scratchpad/*session-log*.md'
git show <commit>^:scratchpad/<name>.md
```

Coverage: 2026-W20, W26–W34 (304 logs, 2026-05-13 – 2026-08-21).

`removed-documents.md` indexes the planning documents and binary artifacts
removed alongside the logs, each with its subject line, so a document can be
found by topic rather than by filename.

New session logs are still written to `scratchpad/` under the convention in
`scratchpad/README.md`. Fold them into a digest here once the week is closed.
