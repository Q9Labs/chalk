# Nightly recorder control address

This stack reserves the recorder control Elastic IP and associates it with the
instance selected by `instance_id` in the private `CHALK_INFRA_INPUTS` JSON.
Before an approved installation, take that ID from the current release manifest.
Both planning and association reconciliation reject hosts without
`chalk:environment=nightly`. Reassociation is allowed. Removing the address
retains its allocation through Alchemy's persisted removal policy.

## Current status: not allocated

No Nightly recorder control address is currently allocated. The original
OpenTofu state is stale and must not be used to seed a replacement. This stack
has not been deployed or seeded into Alchemy. The OpenTofu source was removed;
the original state and dated backup remain untouched.

The address is still required by `scripts/releases/media.py qualify`: Nightly
qualification requires exactly one allocation with both recorder tags and
reassociates it before either recorder cold boot. Missing allocations fail
closed. The on-demand host-proof workflow introduced in PR #1432 is a separate,
ephemeral proof host; it does not remove this release requirement.

**Do not deploy without approval for a new recurring cost.** A first deployment
with empty Alchemy state creates a new Elastic IP and associates it with the
Nightly instance selected by the input file. It does not recover the former IP or update DNS or
recorder firewalls. An approved first install also needs those private
configuration changes before qualification can succeed.

## Plan and deploy

From the repository root, with AWS access to the Nightly account:

```sh
export AWS_PROFILE=q9labs
export CHALK_INFRA_INPUTS=/absolute/path/to/recording-control-address.json
pnpm --dir infrastructure check-types
pnpm --dir infrastructure exec alchemy plan --config recording-control-address/alchemy.run.ts --stage nightly --detailed
pnpm --dir infrastructure exec alchemy deploy --config recording-control-address/alchemy.run.ts --stage nightly
pnpm --dir infrastructure exec alchemy plan --config recording-control-address/alchemy.run.ts --stage nightly --detailed
pnpm --dir infrastructure exec alchemy drift --config recording-control-address/alchemy.run.ts --stage nightly
```

The commands above describe an approved first install, not a completed cutover.
The first plan will create an address and its association; that plan is not
authorized by the no-change migration approval. After an approved install, the
second plan must contain only no-ops, and drift must exit zero without repair.
Outputs keep the names `public_ip` and `allocation_id`. Read persisted outputs
without a deployment:

```sh
pnpm --dir infrastructure exec alchemy state read recording-control-address/nightly/output --config recording-control-address/alchemy.run.ts
```

Record the live public IP, allocation ID, association ID, and attached instance
before and after cutover. Keep these values private. The release controller may
move the existing allocation during host replacement. Coordinate that change
with a plan rather than racing the controller.

## Roll back

To undo an association change, move the retained allocation back to the previous
host. Reverting source alone does not move it. No live address migration occurred
and there are no Alchemy records to roll back. Restoring the previous commit's
OpenTofu source with its untouched historical state does not recover a released
address; applying that replacement requires separate cost approval. After a
future approved install, retain its current state and allocation when changing
infrastructure tooling. Never release or replace the allocation as an undo.

The narrow release permissions remain in [release-policy.json](release-policy.json).
The migration operator separately needs allocation, tagging, association, and
Alchemy state-store permissions. This stack does not manage production's address.
