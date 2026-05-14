---
name: chalk-release
description: Use when preparing a public-safe Chalk source, package, SDK, web, API, docs, or mobile release, including release-readiness checks, changelog or metadata updates, artifact hygiene, staging, and publish boundaries.
---

# Chalk Release

Use this skill when preparing Chalk release work across source, packages, apps, docs, API, or mobile.

## Guardrails

- Do not publish packages, push tags, deploy infrastructure, upload mobile builds, or promote releases unless Hasan explicitly asks for that final action.
- Keep npm tokens, GitHub tokens, Cloudflare/AWS credentials, signing configs, app bundle IDs, rollout tracks, customer rollout details, and private changelog drafts outside the public repo.
- Public release notes should describe product and SDK changes without exposing customers, private domains, private incidents, operator-only URLs, or account identifiers.
- Public GitHub Actions may validate source, generated API contracts, package license metadata, and tests. Package publishing, production deploys, and mobile publishing belong in private automation.

## Default Flow

1. Check repo status and identify unrelated local changes.
2. Run focused tests for the changed packages or apps.
3. Run the public CI-equivalent checks when practical.
4. Update public changelog, package metadata, generated contracts, or docs only when the release surface actually changed.
5. Confirm generated artifacts, logs, screenshots, and private release notes are not staged.
6. Stage intended files only.
7. Stop before publishing, pushing, tagging, uploading, or promoting unless the user says to ship it.

## Mobile Prep

1. Verify the mobile app builds locally for the intended platform.
2. Run package and app tests that cover the changed mobile surface.
3. Keep signing material, app identifiers, store credentials, and rollout decisions in private operator notes or a vault.
4. Use local environment variables for machine-specific values such as `CHALK_MOBILE_PACKAGE`.
5. Hand off publishing to the private release workflow.

Useful local commands:

```bash
pnpm --dir apps/mobile run android
pnpm --dir apps/mobile run ios
pnpm run mobile:install:local -- --no-launch
```

## Infra Boundary

Release work can verify infrastructure templates, but public release automation must not mutate production infrastructure or read production secrets.
