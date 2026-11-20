# Infrastructure platform

`config.ts` owns shared stage parsing, AWS credentials/providers and DynamoDB
state. `preview-build.json` pins one complete Alchemy preview dependency graph;
`check-preview-build.mjs` rejects partial updates. The application SDK's Effect
runtime is not changed.

## Drift workflow permission contract

The workflow runs only while `CHALK_ALCHEMY_DRIFT_ENABLED=true`, on its schedule
and on manual dispatch alike. Its dedicated `CHALK_ALCHEMY_DRIFT_ROLE_ARN` secret
names a role that trusts GitHub's OIDC provider for this repository's
default-branch workflow (`aud=sts.amazonaws.com`, `sub` of the master ref only).
Do not reuse a deploy role. It needs the following access for each future seeded production cutover, scoped to its existing resources wherever AWS supports it. The active cutover list is the seeded production stages in `registry.ts` (transcription dispatcher, recorder runtime downloads, SFU, SFU standby and recorder); retired Nightly is excluded. Every seeded stack is checked by the same drift scan:

| Boundary                                   | Actions                                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Caller identity                            | `sts:GetCallerIdentity`                                                                                                                                                                                                        |
| Existing `alchemy-state` table             | `dynamodb:DescribeTable`, `dynamodb:GetItem`, `dynamodb:Query`, limited by `dynamodb:LeadingKeys` to the registered stage partitions and `CATALOG`                                                                             |
| Stage leases on that table                 | `dynamodb:PutItem` for the registered `STAGE#<stack>#production` partitions, limited to the attributes `PK`, `SK`, `token` and `expiresAt`; `dynamodb:DeleteItem` for the same partitions. No `UpdateItem` or `BatchWriteItem` |
| Existing state overflow bucket             | `s3:ListBucket`, `s3:GetBucketLocation` (the state backend checks existence with HeadBucket)                                                                                                                                   |
| Existing state overflow objects            | `s3:GetObject` on the registered stack/stage prefixes in the existing Alchemy overflow bucket                                                                                                                                  |
| Dispatcher IAM roles                       | `iam:GetRole`, `iam:ListRolePolicies`, `iam:GetRolePolicy`, `iam:ListAttachedRolePolicies`, `iam:ListRoleTags`                                                                                                                 |
| Dispatcher queues                          | `sqs:GetQueueAttributes`, `sqs:ListQueueTags`                                                                                                                                                                                  |
| Dispatcher logs                            | `logs:DescribeLogGroups`, `logs:ListTagsForResource`                                                                                                                                                                           |
| Dispatcher function and invoke permissions | `lambda:GetFunction`, `lambda:GetFunctionEventInvokeConfig`, `lambda:GetPolicy`, `lambda:ListTags` on the dispatcher function only                                                                                             |
| Dispatcher schedule                        | `scheduler:GetSchedule`                                                                                                                                                                                                        |
| Dispatcher alarms                          | `cloudwatch:DescribeAlarms`, `cloudwatch:ListTagsForResource`                                                                                                                                                                  |
| Recorder download distributions            | `cloudfront:GetDistribution`, `cloudfront:GetDistributionConfig`, `cloudfront:ListTagsForResource` on the runtime downloads distribution and the recorder archives distribution                                                |
| Recorder download distribution parts       | `cloudfront:GetOriginAccessControl(Config)`, `GetPublicKey(Config)`, `GetKeyGroup(Config)` on `*`, because the scan reads them through ids stored in state                                                                     |
| Recorder download buckets                  | `s3:GetBucketPolicy`, `s3:GetBucketLocation` on the production releases bucket and the recorder artifacts bucket                                                                                                               |
| Recorder encryption key                    | `kms:DescribeKey`, `kms:GetKeyPolicy`, `kms:GetKeyRotationStatus`, `kms:ListResourceTags` on the recorder key; `kms:ListAliases` for the alias read                                                                            |

Provider state reads use existing recorded identities, not account-wide adoption
or list/inventory operations. No workload mutation, state bootstrap, state
resource/output write, overflow write or `drift --repair` permission is needed.
The state table and bucket must already be bootstrapped by an operator; CI
refuses missing infrastructure rather than creating it. Lease writes are the
only intended writes. `PutItem` is limited to the lease attributes, but
`DeleteItem` shares its API action with resource-state rows and `LeadingKeys` cannot
restrict the sort key, so the role could delete a registered stage's state rows.
That residual risk is accepted: the role trusts only the master ref of this repository,
the workflow runs the read-only drift command, and a deleted row shows up as drift
at the next run. Grant this role only to this workflow.

Also configure the existing `ONCALL_WEBHOOK_URL` secret. Detailed provider logs
are kept only in a mode-0700 temporary directory and deleted at the end; CI
prints stack/stage and `clean`, `drift` or `check-failed`, never resource data.
The workflow serializes its own runs, but operators must also sequence it with
manual plans/releases on these stages. A held lease fails the check and alerts;
it does not bypass locking.

The scheduled command runs `platform/drift.ts`, which calls the same drift scan as `alchemy drift`:
it reads state and provider attributes without evaluating stack declarations. A record the scan
skips (no provider `read`, or a record that is creating, updating or deleting) is `check-failed`,
not `clean`, because it was never compared with the real resource. Thus it does not need the
download public key file or dispatcher runtime input files. A role that lacks one of the reads
above fails the check with `check-failed`; set `CHALK_ALCHEMY_DIAGNOSTICS` to a private file to
see which action was denied. IAM changes take up to a minute to reach every endpoint, so retry
once before you read a fresh denial as a policy gap. Confirm access with one clean manual
run (`gh workflow run infrastructure-drift.yml --ref master`) before you enable the variable.

SFU, SFU standby and recorder plans load their private stack inputs, so the check step reads
them from the `CHALK_SFU_INPUTS`, `CHALK_SFU_STANDBY_INPUTS` and `CHALK_RECORDER_INPUTS` secrets
(JSON files with no credentials) and writes each to a mode-0600 file for the one stack. A stack
whose secret is missing is `check-failed`. Credentials come from read-only provider tokens:
`DIGITALOCEAN_TOKEN` for SFU, `CHALK_CAPTURE_DIGITALOCEAN_TOKEN` and `CHALK_RENDER_DIGITALOCEAN_TOKEN`
for the recorder pools, and `CLOUDFLARE_API_TOKEN` with `CLOUDFLARE_ACCOUNT_ID` for the recorder R2
bucket. The DigitalOcean tokens are custom-scoped read tokens (droplet, firewall, tag, ssh_key,
image and project read), never a full-access token. Media relay uses Calls TURN key reads. Do not
grant every future provider in advance: configure only the registered production cutovers before
enabling their checks.
