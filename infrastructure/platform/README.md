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
deploy role. It needs the following access for the two currently cut-over
Nightly stacks, scoped to their existing resources wherever AWS supports it:

| Boundary | Actions |
| --- | --- |
| Caller identity | `sts:GetCallerIdentity` |
| Existing `alchemy-state` table | `dynamodb:DescribeTable`, `dynamodb:GetItem`, `dynamodb:Query` |
| Stage leases on that table | `dynamodb:PutItem`, `dynamodb:DeleteItem` for `STAGE#archive-cdn#nightly` and `STAGE#transcription-dispatcher#nightly` partitions; Alchemy uses conditional writes to acquire, renew and release the `LEASE` row |
| Existing state overflow objects | `s3:GetObject` on the two stack/stage prefixes in the existing Alchemy overflow bucket |
| Archive CDN | `cloudfront:GetDistribution`, `cloudfront:GetDistributionConfig`, `cloudfront:ListTagsForResource`, `cloudfront:GetPublicKeyConfig`, `cloudfront:GetKeyGroupConfig`, `cloudfront:GetOriginAccessControlConfig`; `s3:GetBucketPolicy` for the existing artifacts bucket |
| Dispatcher IAM roles | `iam:GetRole`, `iam:ListRolePolicies`, `iam:GetRolePolicy`, `iam:ListAttachedRolePolicies`, `iam:ListRoleTags` |
| Dispatcher queues | `sqs:GetQueueAttributes`, `sqs:ListQueueTags` |
| Dispatcher logs | `logs:DescribeLogGroups`, `logs:ListTagsForResource` |
| Dispatcher function and invoke permissions | `lambda:GetFunction`, `lambda:GetFunctionEventInvokeConfig`, `lambda:GetPolicy` |
| Dispatcher schedule | `scheduler:GetSchedule` |
| Dispatcher alarms | `cloudwatch:DescribeAlarms`, `cloudwatch:ListTagsForResource` |

Provider state reads use existing recorded identities, not account-wide adoption
or list/inventory operations. No workload mutation, state bootstrap, state
resource/output write, overflow write or `drift --repair` permission is needed.
The state table and bucket must already be bootstrapped by an operator; CI
refuses missing infrastructure rather than creating it. Lease writes are the
only intended writes and share the DynamoDB API actions with resource-state
writes. A partition condition limits the two stages but cannot restrict the
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
archive public key file or dispatcher runtime input files. Confirm role access
and one clean manual run before enabling the schedule. No live access test was
performed in the structure lane.
