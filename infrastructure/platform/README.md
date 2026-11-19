# Infrastructure platform

`config.ts` owns shared stage parsing, AWS credentials/providers and DynamoDB
state. `preview-build.json` pins one complete Alchemy preview dependency graph;
`check-preview-build.mjs` rejects partial updates. The application SDK's Effect
runtime is not changed.

## Drift workflow permission contract

The scheduled workflow is gated by `CHALK_ALCHEMY_DRIFT_ENABLED=true`; this
change does not set the variable, create a role or change IAM. Its dedicated
`CHALK_ALCHEMY_DRIFT_ROLE_ARN` must trust GitHub's OIDC provider for this
repository's default-branch workflow (`aud=sts.amazonaws.com`). Do not reuse a
deploy role. It needs the following access for each future seeded production cutover, scoped to its existing resources wherever AWS supports it. The current active cutover list is empty; retired Nightly is excluded:

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

The scheduled command uses `alchemy drift`, which reads state and provider
attributes without evaluating stack declarations. Thus it does not need the
retired download public key file or dispatcher runtime input files. Confirm role access
and one clean manual run before enabling the schedule. No live access test was
performed in the structure lane.

Future SFU/recorder/media-relay cutovers also need their protected read-capable
DigitalOcean/Cloudflare token secrets on the check step. SFU uses DigitalOcean
resource reads and Cloudflare DNS reads; recorder uses its separate pool-token
resource reads and Cloudflare R2 bucket/CORS/lifecycle reads; media relay uses
Calls TURN key reads. Retired recorder runtime downloads need no drift role or
CloudFront permission. Do not grant every future provider in advance: configure
only the registered production cutovers before enabling their checks.
