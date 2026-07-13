
## 2026-07-13 17:00 PKT — review of `fb78b42f`

The commit only renames the already-shipped declarative Sync v3 migration from `20260712233000` to `20260713130000` and edits compatibility constraints. The rename is a release-blocking migration bug: Goose tracks applied versions, so databases that applied the old version will see the renamed file as pending and rerun its non-idempotent DDL. No second independent defect was confirmed in the constraint edits.
