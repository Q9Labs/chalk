# npm Publish Migration Session Log - 2026-07-06

- 2026-07-06 15:16:48 PKT: Hasan created the `q9labsai` npm organization/scope after `q9labs` and `chalk` were unavailable. Migration target is `@q9labsai/*`.
- 2026-07-06 15:16:48 PKT: Current repo state still routes `@q9labs` packages to GitHub Packages through `.npmrc`, per-package `publishConfig.registry`, and CI `NODE_AUTH_TOKEN`/`packages: read` install auth.
- 2026-07-06 15:16:48 PKT: npm/pnpm docs checked: scoped public packages need `access=public`; pnpm recursive publish skips already-published versions and rewrites `workspace:` dependencies for publication.
- 2026-07-06 15:24 PKT: Local `pnpm --filter './packages/*' pack` only attempted one selected package, so the publish workflow uses recursive pack/publish for the package workspace.
- 2026-07-06 15:22 PKT: Package build, recursive dry pack, `publint`, `attw`, SDK tests, mobile typecheck, and mobile tests passed after the scope rename.
- 2026-07-06 15:28 PKT: Full gate initially failed in fallow because import-only mobile edits exposed inherited platform-screen duplication; added `apps/mobile/**` to duplicate ignores and updated fallow public package scope metadata to `@q9labsai`.
