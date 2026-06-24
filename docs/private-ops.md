# Private Ops Notes

Chalk keeps public project memory in this repository and private operational
material outside tracked source.

## Local Private Workspace

Use `.private/` for machine-local files that must never be committed:

- raw production logs and debug bundles
- temporary investigation output
- one-off deployment notes with account or tenant identifiers
- local env files that reference secret manager items

The `.private/` directory is ignored by git.

## Secrets

Store secrets in a dedicated password-manager vault or equivalent secret
manager. Keep personal credentials and project credentials separate.

Prefer secret references at runtime instead of writing resolved values to disk:

```bash
op run --env-file .private/chalk.env -- <command>
```

Committed examples may name required environment variables, but must not include
real password-manager item paths, secret values, account IDs, tenant IDs, or
production credentials.

## Retired Terraform Notes

The legacy Chalk Terraform stack was removed during the 2026 rebuild reset.
Keep any private teardown evidence, backend fragments, and production account
notes outside the tracked tree under `.private/`.

## Public Memory

Public scratchpad notes should preserve reusable lessons:

- why an architecture decision was made
- what failure mode was discovered
- how to verify or recover a class of issue
- which deployment pattern is safe in general terms

Move raw evidence and sensitive operational detail to private storage, then keep
only a sanitized summary in the public scratchpad.
