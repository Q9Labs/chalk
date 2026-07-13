# Sync v3 migration review fixes session log

- 2026-07-13 10:43 PKT — Read the repository, API database workflow, code, and writing rules; inspected the v2 and v3 lifecycle, receipt, foreign-key, trigger, and rollback constraints.
- 2026-07-13 10:51 PKT — Changed the v3 migration to backfill each existing Session deadline from its own `created_at`, preserve legacy v2 rows through `NOT VALID` v3 checks, reject new v2 writes, and validate the checks on clean histories.
- 2026-07-13 10:55 PKT — Seeded PostgreSQL 18.3 at migration `20260712223000` with an old Session, participant lifecycle history, and committed/rejected v2 receipts; directly reproduced all three validated-check failures from the reviewed migration shape.
- 2026-07-13 10:57 PKT — Migrated the representative legacy database to v3 and observed all three intents, both receipts, both legacy NULL field sets, and the per-row deadline survive. Verified fresh v2 inserts fail the v3 checks.
- 2026-07-13 10:58 PKT — Ran a fresh PostgreSQL 18.3 v3 up/down/up cycle, observed all four relevant checks validated on the empty schema, confirmed Goose version `20260712233000`, and ran `goose validate` successfully.
