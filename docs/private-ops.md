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

## Terraform With 1Password

Use 1Password as the source for environment values and Terraform remote state as
the source for state. Commit safe Terraform environment composition, but do not
commit resolved tfvars, backend config, local plans, state files, account IDs, or
production values.

Create a local env file from `infrastructure/terraform/op.env.example`:

```bash
cp infrastructure/terraform/op.env.example .private/chalk-terraform.env
```

Then replace placeholders with `op://...` references from the dedicated project
vault. Keep item paths private when they reveal account or deployment topology.

Run Terraform through the wrapper:

```bash
pnpm run infra:tf -- init
pnpm run infra:tf -- plan
pnpm run infra:tf -- apply
```

The wrapper defaults to `infrastructure/terraform/environments/prod`,
`.private/chalk-terraform.env`, and `.private/terraform/prod.backend.hcl`.
It does not write resolved secrets to disk. Use `CHALK_OP_ACCOUNT` when the local
machine has more than one 1Password account configured.

## Public Memory

Public scratchpad notes should preserve reusable lessons:

- why an architecture decision was made
- what failure mode was discovered
- how to verify or recover a class of issue
- which deployment pattern is safe in general terms

Move raw evidence and sensitive operational detail to private storage, then keep
only a sanitized summary in the public scratchpad.
