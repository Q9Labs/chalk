---
name: gplay-cli-usage
description: Use when inspecting or automating Google Play workflows with the gplay CLI in a local operator environment, especially dry-run, read-only, or approval-gated release operations.
---

# Google Play CLI Usage

Use this skill when you need to inspect or automate Google Play workflows with the `gplay` CLI in a local operator environment.

## Guardrails

- Keep package names, track names, service account files, signing material, and rollout decisions in private operator notes or environment variables.
- Do not commit generated Play Console exports, screenshots, credentials, release artifacts, or upload logs.
- Prefer dry-run or read-only commands while preparing changes. Only upload or promote releases after explicit human approval.
- If a command output includes private app identifiers, customer names, or rollout status, summarize it before adding notes to the public repo.

## Local Setup

The CLI and credentials are operator-local. A typical setup uses:

```bash
gplay --help
gplay apps list
```

For app-specific commands, pass values from your local shell or private vault:

```bash
GPLAY_PACKAGE_NAME="example.package" gplay tracks list "$GPLAY_PACKAGE_NAME"
```

## Public Repo Notes

This repository may include scripts that prepare mobile artifacts, but publishing credentials and release promotion workflows belong outside public CI.
