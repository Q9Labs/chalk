# Chalk web

A Vite, React 19 and TanStack Router app that serves the landing page, docs and legal pages at `/`, and the public-SDK consumer Space at `/space`, including guest admission by public Space link. Implementation status lives in the root [human tracker](../../tracker-human.md); route names and this guide are not release-readiness evidence.

Shared product behavior belongs in the SDK packages. This app stays a thin first-party integration and verification surface, and the `/space` route uses `createChalkPublicClient` from the TypeScript SDK. The pathless Space layout keeps `SpacePage` mounted when the index route replaces the URL with the verified `invite_link`. The dashboard server is described in [`server/README.md`](server/README.md).

`pnpm --dir apps/web dev` binds Vite to `127.0.0.1:3070` and proxies `/v1` to `http://127.0.0.1:8080`; set `CHALK_DEV_API_ORIGIN` for another API. Production builds set `VITE_API_URL` to the public API origin. `test`, `check-types` and `build` run the same way.

## Web release

`pnpm run release:web` (runner: `scripts/deploy/deploy-web-release.mjs`, Node 22 or newer) builds once, uploads that same `dist/client` to staging, verifies it, then uploads and verifies production. It needs an exact 40-character commit SHA and works from a clean detached checkout that the local command creates, so unrelated work in the shared repository cannot enter a release. Staging is the safety gate; use `--skip-staging` only for an approved fast production repair. `--dry-run` prints the preflight and command plan without building or uploading.

Keep Cloudflare credentials as `op://...` references in an untracked env file and inject them with `op run`:

```bash
# .private/chalk-web-release.env: CLOUDFLARE_API_TOKEN=op://... and CLOUDFLARE_ACCOUNT_ID=op://...
op run --env-file=.private/chalk-web-release.env -- pnpm run release:web
```

After a force-killed local release, add `-- --recover-stale-lock` only once no release process runs; the runner refuses to remove a live lock. CI injects `CLOUDFLARE_API_TOKEN` from its secret store and runs `pnpm run release:web:ci -- --sha "$GITHUB_SHA"`.

The runner passes the full SHA into the build metadata and service worker and always runs the deployment verifier after each upload. Local releases keep the Turbo cache in the main checkout at `.turbo/cache` (override with `CHALK_WEB_TURBO_CACHE_DIR`, a path inside that checkout), so dependency builds are reused across SHAs while the web build still keys on its exact SHA. CI restores the same path.
