# Cut over the DigitalOcean stacks

Run these commands from the repository root. Read the
[migration reference](digitalocean-migration.md) first. The observed Nightly states
are stale, the primary production SFU differs from the current firewall definition,
and the recorder has CORS and pool-firewall drift. Do not use these commands to recreate
missing resources or overwrite live policy.

## Prepare the private inputs

1. Freeze infrastructure writers for the selected root.
2. Save the current commit, original cloud identities, configuration and creation
   times privately. Include the Droplet's size, image, IP addresses, attachments,
   firewall rules and operator key fingerprint.
3. Set the private JSON input paths and credentials described in the reference.
   Do not copy tokens into JSON. Run the credential-free checks:

   ```sh
   pnpm --dir infrastructure check-types
   pnpm --dir infrastructure test:digitalocean
   python3 -m unittest discover -s infrastructure/sfu -p test_templates.py
   ```

4. Read each original state to a private directory. For production, an operator
   runs the following commands. This lane ran only the downloads, not the copies
   or the later production write commands:

   ```sh
   export AWS_PROFILE=q9labs
   export DIGITALOCEAN_TOKEN="$(doctl auth token)"
   account_id=$(aws sts get-caller-identity --query Account --output text)
   state_bucket="chalk-production-state-${account_id}-ap-southeast-1"
   backup_prefix="alchemy-migration-backup/$(date -u +%Y-%m-%dT%H%M%SZ)"
   migration_dir=$(mktemp -d)
   chmod 700 "$migration_dir"
   for stack in sfu sfu-standby; do
     aws s3api copy-object --bucket "$state_bucket" --copy-source "$state_bucket/$stack/terraform.tfstate" --key "$backup_prefix/$stack/terraform.tfstate" >/dev/null
     aws s3 cp "s3://$state_bucket/$stack/terraform.tfstate" "$migration_dir/$stack.json" --only-show-errors
   done
   aws s3api copy-object --bucket "$RECORDER_STATE_BUCKET" --copy-source "$RECORDER_STATE_BUCKET/$RECORDER_STATE_KEY" --key "$backup_prefix/recorder/terraform.tfstate" >/dev/null
   aws s3 cp "s3://$RECORDER_STATE_BUCKET/$RECORDER_STATE_KEY" "$migration_dir/recorder.json" --only-show-errors
   ```

   Set `RECORDER_STATE_BUCKET` and `RECORDER_STATE_KEY` from the existing private
   backend configuration. Never change the original state objects.

## Validate production without writes

Run all operations sequentially. Stop when a dry-run rejects a resource or drift:

```sh
AWS_PROFILE=q9labs pnpm --dir infrastructure exec tsx alchemy/seed-tofu-state.ts sfu production "$migration_dir/sfu.json" --dry-run
AWS_PROFILE=q9labs pnpm --dir infrastructure exec tsx alchemy/seed-tofu-state.ts sfu-standby production "$migration_dir/sfu-standby.json" --dry-run
AWS_PROFILE=q9labs pnpm --dir infrastructure exec tsx alchemy/seed-tofu-state.ts recorder production "$migration_dir/recorder.json" --dry-run
```

The two SFU validations must each report two live mappings. Standby currently
passes; primary refuses the TCP media-rule mismatch between its live/source rules
and the current definition. Recorder must report seven. Today its original state
fails the live CORS comparison. Independent reads also found a changed
control-plane destination in both pool firewalls. Resolve all inventory
discrepancies explicitly before proceeding. Do not weaken the importer or guess
the live origins. No production plan was run by this lane.

## Seed and plan production as the lead

Only the lead performs these state writes after successful dry-runs and backups.
The explicit environment flag unlocks production seeding, not deployment.
Stop on the first unexpected plan action:

```sh
CHALK_ALCHEMY_PRODUCTION_SEED=approved AWS_PROFILE=q9labs pnpm --dir infrastructure exec tsx alchemy/seed-tofu-state.ts sfu production "$migration_dir/sfu.json"
CHALK_SFU_STACK=sfu CHALK_SFU_CONFIG_FILE="$private_dir/sfu.json" AWS_PROFILE=q9labs pnpm --dir infrastructure exec alchemy plan --config sfu/alchemy.run.ts --stage production --detailed --no-input
CHALK_ALCHEMY_PRODUCTION_SEED=approved AWS_PROFILE=q9labs pnpm --dir infrastructure exec tsx alchemy/seed-tofu-state.ts sfu-standby production "$migration_dir/sfu-standby.json"
CHALK_SFU_STACK=sfu-standby CHALK_SFU_CONFIG_FILE="$private_dir/sfu-standby.json" AWS_PROFILE=q9labs pnpm --dir infrastructure exec alchemy plan --config sfu/alchemy.run.ts --stage production --detailed --no-input
CHALK_ALCHEMY_PRODUCTION_SEED=approved AWS_PROFILE=q9labs pnpm --dir infrastructure exec tsx alchemy/seed-tofu-state.ts recorder production "$migration_dir/recorder.json"
CHALK_RECORDER_CONFIG_FILE="$private_dir/recorder.json" AWS_PROFILE=q9labs pnpm --dir infrastructure exec alchemy plan --config recorder/alchemy.run.ts --stage production --detailed --no-input
```

Set `private_dir` to the private JSON-input directory, not the state-download
directory. Keep the exported DigitalOcean and Cloudflare credentials available.
Recorder planning requires its original production adoption and qualification
acknowledgments, the existing release ID and the original rule IDs.

Expected resource actions after a valid seed and matching inputs:

| Stack         | Expected detailed plan                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `sfu`         | `Node noop`, `Firewall noop`                                                                                                    |
| `sfu-standby` | `Node noop`, `Firewall noop`                                                                                                    |
| `recorder`    | `RecordingKey`, `RecordingAlias`, `RecordingBucket`, `CaptureTag`, `RenderTag`, `CaptureFirewall`, `RenderFirewall`: all `noop` |

These are the acceptance criteria, not production receipts. Output initialization
may appear separately because legacy outputs have not been written to Alchemy.
An observable policy change, resource create, replacement or deletion must stop
the cutover. No production deploy is included in this handoff.

## Cut over Nightly only after its original resources are found

Neither currently downloaded Nightly state is eligible. Both missing Droplets
and firewalls must be investigated before a cutover. Do not deploy their current
create plans.

For an eligible Nightly stack, use its Nightly bucket and original state key.
Copy that state to a dated backup key first. Run seed dry-run, seed, detailed
plan, deploy, second plan and read-only drift sequentially. The first plan must
contain only no-ops or explicitly verified non-observable in-place updates.
The second plan must be all no-ops, drift must exit zero, and the before/after
cloud identities and facts must match. Never run a destroy or nuke command.

After successful cutovers and release-driver integration, remove the legacy
roots only when no script calls them. Remove the shared OpenTofu toolchain only
when the merged branches have no remaining consumers.
