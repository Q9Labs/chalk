# Nightly backend configuration

Nightly runs the same backend images as production with separate data, keys and provider resources. Runtime configuration files contain no credentials; the OpenTofu roots provision nightly infrastructure. Use `nightly` as the deployment identity. Sync still builds with `MIX_ENV=prod`. Component names, hosts and per-container memory caps live in [`infrastructure/managed-episode/contracts/environments.json`](../managed-episode/contracts/environments.json) and the Quadlet units (`render-runtime <manifest> <output> nightly` selects the nightly caps), not here.

The [runtime input contract](../managed-episode/contracts/runtime-inputs.json) is the exact ID-to-SSM-suffix map. Prefix every suffix with `/chalk/nightly/managed-episode`. Environment files, migrator credentials and secret files use SecureString; the database proof uses String. Issue new bridge, controller, issuer and worker trust roots. Keep internal service aliases and SPIFFE identities, but never share a production signing key or trust root. Nightly and production select the same qualified recorder image IDs; boot-time configuration supplies each environment's own issuer CA and server name.

Start from the [API example](../managed-episode/env/api.nightly.env.example), [Sync example](../managed-episode/env/sync.nightly.env.example) and the recorder examples in `env/`. Supply all placeholders privately.

## Host bootstrap and memory

Supply `host-cloud-init.yaml` as user-data when an operator launches the approved Ubuntu arm64 host. It checks cgroups v2, Quadlet and the rootless user manager, then runs a disposable rootless smoke container, and holds no runtime secrets. Verify SSM Online and a successful reboot before deployment.

The 2 GiB host fits only because nightly caps are smaller than production's. The issuer keeps production's 256 MiB cap because a 32 MiB cap caused cgroup OOM kills during recorder bootstrap. The caps are configured limits, not a load measurement: verify headroom during the synthetic recording and transcription call, and treat an out-of-memory failure as rejecting the candidate.

### Stable recorder address

The nightly Spot host must use the Elastic IP owned by [`recording-control-address`](recording-control-address/main.tf). An automatic public IP changes after a Spot stop and start, leaving the recorder's direct TLS hostname pointing at the old address, and the API tunnel does not replace that listener.

Apply this root once to install the retained allocation. On later host replacements, update the nightly release configuration's `runtime.instance_id` and the nightly managed deployment target together. Release calls `scripts/releases/media.py qualify` after deployment and before either recorder cold boot; that moves the tagged allocation to the SSM target and waits for AWS to confirm. A retry after a lost response observes the completed move. Missing or ambiguous allocations fail closed, and Release never allocates, releases or changes DNS. The root has its own state so the allocation survives host replacement; only the association moves. Never destroy or recreate the allocation during replacement.

```sh
tofu -chdir=infrastructure/nightly/recording-control-address init -backend-config=/absolute/path/to/nightly-backend.hcl
tofu -chdir=infrastructure/nightly/recording-control-address plan -out=address.plan
tofu -chdir=infrastructure/nightly/recording-control-address apply address.plan
tofu -chdir=infrastructure/nightly/recording-control-address output -raw public_ip
```

Save the `allocation_id` output durably with the private backend coordinates and DNS undo before replacing a host or removing the root. If it is lost, recover it read-only by tags, match the public IP to `nightly-recording-control.chalkmeet.com`, then import:

```sh
aws ec2 describe-addresses --region ap-southeast-1 --filters Name=tag:Name,Values=chalk-nightly-recording-control Name=tag:chalk:environment,Values=nightly --query 'Addresses[].{AllocationId:AllocationId,PublicIp:PublicIp}'
```

The release needs [release-policy.json](recording-control-address/release-policy.json), which allows address and instance reads and association of only the allocation with both nightly recorder tags, and nothing else (no allocate, release, disassociate, DNS or IAM-write). Account-specific installation and undo are in the private **Nightly recorder address permissions** runbook in the ignored `.private/` workspace.

On the first install only, save the full Cloudflare record as the undo and set only the DNS-only A record `nightly-recording-control.chalkmeet.com` to the output, keeping its TTL. Append `/32` to the output for the capture and render recorder policies' `control_addresses` and apply both firewalls before the cold-boot check. Confirm the public DNS answer matches before the signed recorder cold-boot check, and keep the record unchanged across host replacements.

To undo an association change, move the retained allocation back to the previous host. Reverting code does not release the live address, because `lifecycle.destroy = false` persists the retention policy in state. If a removal apply forgets the allocation, import the saved `allocation_id` into `aws_eip.control` before applying the restored root. Production's recorder address is not managed by this root.

## Database and privacy

Create an empty database, not a branch or restore of production, and verify empty user tables before the first migration. Use the dedicated owner credential only in the migrator mount. Single-node configuration disables the standby requirement but still verifies writability, fsync, full-page writes, checksums and synchronous commit. The [add-only migration rule](../../apps/api/docs/database-workflow.md) applies to nightly and production. Transcription requires explicit privacy acceptance and a qualified corpus digest before the module can plan.

## Transcription caller

Release builds and qualifies a dispatcher ZIP when its inputs changed or nightly has no complete installation. It initializes this caller with the nightly state bucket, imports the two provisioned IAM roles and the `/aws/lambda/chalk-nightly-transcription-dispatcher` log group if absent from state, and applies a non-destructive first-install plan. A retry resumes partial state. After the backend is healthy, Release deploys the exact versioned ZIP and enables the reconciler before the signed recorder boot and transcript proof. Promote copies the same ZIP bytes to production without rebuilding. Normal updates permit only code, release binding metadata and scheduler state changes. The nightly schedule stays disabled until the lead authorizes the first cut.

Recorder policy inputs for nightly are `environment=nightly`, `staging_evidence_digest`, `ready_spare=0`, zero capture reservations and `render_desired_nodes=0`, plus the nightly control role, control addresses, R2 account and image evidence. The policy root never creates runtime Droplets; its API reconciler does.
