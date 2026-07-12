---
name: chalk-incident-status
description: Use when working on Chalk incident or status tooling in source code or local development, including public-safe status UI, tests, CI boundaries, and reusable debugging notes
disable-model-invocation: true
---

# Chalk Incident Status

Use this skill when working on Chalk's incident/status tooling in source code or local development.

## Guardrails

- Public repo work should cover code, tests, and generic operational behavior only.
- Keep production URLs, account IDs, credentials, customer names, private monitors, and incident timelines out of committed notes.
- If you need live status context, read it from private operator tooling and summarize only the reusable engineering lesson in public docs.

## Local Workflow

1. Inspect the relevant status or ops UI code.
2. Run the smallest tests that cover the changed behavior.
3. For UI changes, verify the local view in a browser.
4. Record durable, non-private debugging lessons in `scratchpad/debugging-lessons.md`.

## Public CI Boundary

Public GitHub Actions may test status tooling, but must not deploy status pages, mutate monitors, or read production secrets.
