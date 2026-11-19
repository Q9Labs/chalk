# Direct Sync network

`alchemy.run.ts` uses the shared Alchemy AWS and Cloudflare providers at
`2.0.0-beta.87`. It preserves the Nightly-only boundary, host environment-tag
postcondition, DNS-name validation, security group name, TCP 443 ingress,
optional IPv6 rule and AAAA record, DNS-only records with TTL 60 and their
comments, and the `security_group_id` and `direct_sync_url` outputs.

The custom interface resource manages one security-group membership. It reads
the interface's full current group list before each update, keeps all other
groups, and refuses to remove its last group. It never creates or attaches an
interface. Keep other writers off that interface during a change: EC2's group
list update has no compare-and-swap operation.

## Inputs and credentials

Provide private values through the environment, never tracked files:

| Input                       | Variable                                                  |
| --------------------------- | --------------------------------------------------------- |
| AWS credentials             | `AWS_PROFILE=q9labs` or the AWS credential chain          |
| Host region                 | `CHALK_DIRECT_SYNC_AWS_REGION` (default `ap-southeast-1`) |
| Host instance               | `CHALK_DIRECT_SYNC_INSTANCE_ID`                           |
| Lowercase DNS hostname      | `CHALK_DIRECT_SYNC_HOST`                                  |
| Cloudflare zone and account | `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_ACCOUNT_ID`             |
| Stable public IPv4          | `CHALK_DIRECT_SYNC_IPV4`                                  |
| Optional IPv6               | `CHALK_DIRECT_SYNC_IPV6` (unset means no IPv6 resources)  |
| Cloudflare credentials      | `CLOUDFLARE_API_TOKEN`, or an Alchemy Cloudflare profile  |

The shell's Wrangler wrapper loads the existing 1Password-backed Cloudflare
token. Call `_load_cloudflare_api_token` in that shell before Alchemy; calling
Alchemy itself does not invoke the wrapper. State always uses `AWS.state({ migrateFrom: false })` in
`ap-southeast-1`, independently of the host region.

## Cutover status and procedure

**Blocked, not deployed.** The saved Nightly interface no longer exists, and the
saved instance lookup returns no instances. The security group, IPv4 rule and
DNS record still exist. The migration dry run rejects this stale state before
writing Alchemy records. Do not substitute a current host or recreate the
attachment as part of adoption. The original `opentofu/` files remain until a
reviewed resolution and successful no-change cutover; do not run both owners.

1. Follow the [shared migration procedure](../../README.md#migrate-an-existing-root).
   Copy `direct-sync/nightly/terraform.tfstate` to a dated backup in its same
   state bucket. Preserve the original object. Capture live security group ID,
   complete rules, full interface group list, and DNS IDs, names, values, proxy
   settings and TTL privately. Check every saved object still exists.
2. Once the stale-state blocker is resolved, seed with the original state:

   ```sh
   pnpm --dir infrastructure exec tsx migration/seed.ts direct-sync nightly "$direct_sync_state_file" --dry-run
   pnpm --dir infrastructure exec tsx migration/seed.ts direct-sync nightly "$direct_sync_state_file"
   pnpm --dir infrastructure exec alchemy plan --config direct-sync/alchemy.run.ts --stage nightly --detailed
   ```

3. Require only no-ops or in-place ownership-tag additions with no product
   effect. Stop on any create, replacement or delete, including DNS. Do not use
   `--adopt` or deploy as a way around missing seed state.
4. Only after that plan passes:

   ```sh
   pnpm --dir infrastructure exec alchemy deploy --config direct-sync/alchemy.run.ts --stage nightly --yes
   pnpm --dir infrastructure exec alchemy plan --config direct-sync/alchemy.run.ts --stage nightly --detailed
   pnpm --dir infrastructure exec alchemy drift --config direct-sync/alchemy.run.ts --stage nightly
   bash infrastructure/managed-episode/direct-sync/test-direct-sync-proxy
   ```

   Keep logs private. Require an all-no-op second plan, read-only drift exit 0,
   and identical before/after live facts. Never pass `--repair` or `--yes` to
   drift. Remove the legacy `.tf` and backend example only after this proof.

## Rollback

After a successful cutover, forget only this stack's Alchemy records:

```sh
pnpm --dir infrastructure exec alchemy state delete direct-sync/nightly --recursive --config direct-sync/alchemy.run.ts --no-input
```

Restore the pre-cutover commit's OpenTofu configuration, initialize its original
backend, and inspect a plan against the untouched original state. Ownership-tag
differences may remain. Do not redeploy Alchemy without reseeding. Never run
`tofu destroy`, `alchemy destroy` or `alchemy nuke` during migration or rollback.
Turning the client flag off remains the immediate product rollback; see the
[operator guide](../../../docs/operators/direct-sync-path.md).
