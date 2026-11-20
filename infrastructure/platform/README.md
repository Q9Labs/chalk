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
Do not reuse a deploy role. It needs the following access for each future seeded production cutover, scoped to its existing resources wherever AWS supports it. The active cutover list is the seeded production stages in `registry.ts` (recorder runtime downloads and the transcription dispatcher); retired Nightly is excluded. Recorder runtime downloads is a seeded stack that the drift scan checks like any other:

| Boundary                                   | Actions                                                                                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caller identity                            | `sts:GetCallerIdentity`                                                                                                                                                          |
| Existing `alchemy-state` table             | `dynamodb:DescribeTable`, `dynamodb:GetItem`, `dynamodb:Query`                                                                                                                   |
| Stage leases on that table                 | `dynamodb:PutItem`, `dynamodb:DeleteItem` for the registered `STAGE#<stack>#production` partition; Alchemy uses conditional writes to acquire, renew and release the `LEASE` row |
| Existing state overflow bucket             | `s3:ListBucket` (the state backend checks existence with HeadBucket)                                                                                                             |
| Existing state overflow objects            | `s3:GetObject` on the registered stack/stage prefixes in the existing Alchemy overflow bucket                                                                                    |
| Dispatcher IAM roles                       | `iam:GetRole`, `iam:ListRolePolicies`, `iam:GetRolePolicy`, `iam:ListAttachedRolePolicies`, `iam:ListRoleTags`                                                                   |
| Dispatcher queues                          | `sqs:GetQueueAttributes`, `sqs:ListQueueTags`                                                                                                                                    |
| Dispatcher logs                            | `logs:DescribeLogGroups`, `logs:ListTagsForResource`                                                                                                                             |
| Dispatcher function and invoke permissions | `lambda:GetFunction`, `lambda:GetFunctionEventInvokeConfig`, `lambda:GetPolicy`                                                                                                  |
| Dispatcher schedule                        | `scheduler:GetSchedule`                                                                                                                                                          |
| Dispatcher alarms                          | `cloudwatch:DescribeAlarms`, `cloudwatch:ListTagsForResource`                                                                                                                    |
| Recorder download distribution             | `cloudfront:GetDistribution`, `cloudfront:GetDistributionConfig`, `cloudfront:ListTagsForResource` on that distribution                                                         |
| Recorder download distribution parts       | `cloudfront:GetOriginAccessControl(Config)`, `GetPublicKey(Config)`, `GetKeyGroup(Config)` on `*`, because the scan reads them through ids stored in state                      |
| Recorder download bucket                   | `s3:GetBucketPolicy`, `s3:ListBucket`, `s3:GetBucketLocation` on the existing artifact bucket                                                                                    |

Provider state reads use existing recorded identities, not account-wide adoption
or list/inventory operations. No workload mutation, state bootstrap, state
resource/output write, overflow write or `drift --repair` permission is needed.
The state table and bucket must already be bootstrapped by an operator; CI
refuses missing infrastructure rather than creating it. Lease writes are the
only intended writes and share the DynamoDB API actions with resource-state
writes. A partition condition limits the registered stages but cannot restrict the
sort key with `dynamodb:LeadingKeys`; grant this role only to this workflow and
keep the explicit read-only command boundary.

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

Future SFU/recorder/media-relay cutovers also need their protected read-capable
DigitalOcean/Cloudflare token secrets on the check step. SFU uses DigitalOcean
resource reads and Cloudflare DNS reads; recorder uses its separate pool-token
resource reads and Cloudflare R2 bucket/CORS/lifecycle reads; media relay uses
Calls TURN key reads. Do not grant every future provider in advance: configure
only the registered production cutovers before enabling their checks.
