# Chalk docs and SEO web release

## Scope

- Release mode: web only.
- Production target: `https://chalkmeet.com`.
- Approved inputs: docs commit `00adcf5a` and public-site discovery/social work.
- SDK packages, API, and Sync are outside this release.

## Preparation

- Fetched `origin/master` and created the isolated release worktree at
  `/Users/macmini/code/chalk-release-web-20260819-v1` from the fetched revision.
- Applied the docs and SEO changes without the three unrelated commits beneath
  the docs commit in the shared checkout.
- Resolved the changelog conflict by retaining production history and adding
  only the docs and discovery entries.
- Preserved prerendered public HTML and the separate SPA shell so crawlers see
  route-specific metadata while client routes keep their fallback.

## Verification

- Helium dogfood passed landing-to-docs navigation, Quickstart, focused search,
  no-results search, focus return on Escape, mobile navigation, and the long
  Performance article. The first MDX load delay did not reproduce after Vite's
  cold compile.
- The full gate cleared routing, vocabulary, hygiene, secrets, static security,
  dependency scanning, API, Sync, contracts, generated drift, and type checks.
  A local retry later hit unrelated resource-timeout failures while another
  repository gate was running. Focused docs/discovery tests, fallow, the exact
  web build, and Wrangler Pages routing proof passed after the final fixes.
- Wrangler proof confirmed public pages and app deep links return HTML, unknown
  routes return the shell-backed 404, and `sw.js`, the manifest, and the social
  image retain their correct content types.

## Release

- Release SHA: `dd6aac725866a75385ebb020364e3c779b5d676a`.
- Green workflow: `https://github.com/Q9Labs/chalk/actions/runs/32248895881`.
- Verified staging artifact: `https://2950d94f.chalk-staging.pages.dev`.
- Production: `https://chalkmeet.com`.
- The independent production verifier passed on its first attempt, and
  `origin/master` matched the release SHA after deployment.
- No SDK, API, or Sync release was shipped.
