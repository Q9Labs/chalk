# Nightly recorder control address

This stack reserves the recorder control Elastic IP and associates it with the
instance in `/chalk/nightly/release/recorder.json` at `runtime.instance_id`.
Both planning and association reconciliation reject hosts without
`chalk:environment=nightly`. Reassociation is allowed. Removing the address
retains its allocation through Alchemy's persisted removal policy.

The Alchemy definition is ready for migration, but live cutover is not complete.
The OpenTofu configuration remains for recovery. Follow the
[shared migration procedure](../../README.md#migrate-an-existing-root) before the
first plan. Do not allocate a replacement when an existing address is missing.

## Plan and deploy

From the repository root, with AWS access to the Nightly account:

```sh
export AWS_PROFILE=q9labs
pnpm --dir infrastructure check-types
pnpm --dir infrastructure exec alchemy plan --config nightly/recording-control-address/alchemy.run.ts --stage nightly --detailed
pnpm --dir infrastructure exec alchemy deploy --config nightly/recording-control-address/alchemy.run.ts --stage nightly
pnpm --dir infrastructure exec alchemy plan --config nightly/recording-control-address/alchemy.run.ts --stage nightly --detailed
pnpm --dir infrastructure exec alchemy drift --config nightly/recording-control-address/alchemy.run.ts --stage nightly
```

Deploy only after the first plan satisfies the shared migration rules. The
second plan must contain only no-ops, and drift must exit zero without repair.
Outputs keep the names `public_ip` and `allocation_id`. Read persisted outputs
without a deployment:

```sh
pnpm --dir infrastructure exec alchemy state read recording-control-address/nightly/output --config nightly/recording-control-address/alchemy.run.ts
```

Record the live public IP, allocation ID, association ID, and attached instance
before and after cutover. Keep these values private. The release controller may
move the existing allocation during host replacement. Coordinate that change
with a plan rather than racing the controller.

## Roll back

To undo an association change, move the retained allocation back to the previous
host. Reverting source alone does not move it. To undo the Alchemy migration,
[delete this stack's Alchemy state records and restore the previous commit's
OpenTofu configuration](../../README.md#undo-a-cutover), using the untouched
original state. Never release or replace the allocation as an undo.

The narrow release permissions remain in [release-policy.json](release-policy.json).
The migration operator separately needs allocation, tagging, association, and
Alchemy state-store permissions. This stack does not manage production's address.
