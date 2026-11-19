# Transcription dispatcher

This stack serves persistent production and run-owned `nightly-<run-id>` release proofs. Bare Nightly is retired; see [retirement and proof commands](../migration/README.md). Production remains OpenTofu-owned and unseeded.
`@chalk/infrastructure` uses the unified [pinned preview build](../README.md#alchemy-stacks), including its AWS provider.
The entrypoint is `infrastructure/transcription-dispatcher/alchemy.run.ts`; the stage
selects the environment, not a different implementation.

## Resources and inputs

The stack keeps the existing Lambda, two SQS queues and their policies, two IAM
roles and their inline policies, log group, one-minute schedule, Lambda invoke
permissions, asynchronous failure destination and five alarms. Inline policies,
queue policies and event-invoke configuration are folded into their owning
Alchemy resources. Thirteen resources are managed when the optional control API
permission is absent; fourteen when it is present. Existing physical names,
tags, SSE-SQS and the queues' 256 KiB message limit are preserved.

[`config.ts`](config.ts) checks the former module's validations and preconditions before
planning. It also checks that the hexadecimal and base64 ZIP hashes agree.
Defaults do not enable a provider. Provider credentials and workload credentials
remain SSM SecureStrings; the Lambda receives exact parameter ARNs, not their
values. Disabled-provider configuration and unset identity pins are omitted.
The execution role cannot read reusable object-storage credentials or databases.
`required_egress_destinations` is an inventory, not a network-enforced allowlist.
Default Lambda networking has no VPC, NAT gateway or proxy.

Timing remains bounded: work must leave at least 60 seconds for completion,
reserved concurrency is 3–50, and the schedule delivers only a wake-up hint.
The API owns fenced jobs and reconciliation. Async and scheduler failures go to
separate durable queues. Keep scheduling disabled until the API signing and
invocation prerequisites are healthy. The API runtime's invoke role is separate;
`control_api_invoke_policy_json` exposes its required policy without owning it.

Each environment's complete inputs are stored as the redacted
`dispatcher_inputs` stack output in `AWS.state()`, in `ap-southeast-1`. This
replaces the generated temporary generated JSON root and tfvars. Release commands
refuse an environment that has not been explicitly seeded. They never fall back
to OpenTofu state. Keep input JSON, detailed plans, state exports and diagnostics
private; none belongs in Git or CI artifacts.

## Release safety

[`../releases/driver.ts`](../releases/driver.ts) keeps the state lease while it
projects, checks and applies the same in-memory Alchemist plan. The stack opts
into [`policy.ts`](policy.ts): no-op preflight, binding-only, exact-media release
and MAI configuration are closed policies. Unexpected/duplicate/partial resource
sets, type swaps, creates, replacements, deletes, actions, bindings, unknown props,
live drift, unrelated inputs/outputs and changes outside exact property edits
fail before apply. A release refuses missing seed state, never imports it.

The generic checker and apply boundary live under `releases/`, alongside tests
that prove a changed declaration cannot substitute a second plan. Every apply
requires a converged second plan under the same lease. Python retains artifact
copying, input construction and cloud readback, not a second copy of the plan
policy. Private detailed plans and diagnostics never enter Git or CI artifacts.
A dry run checks the current-state preflight when the future versioned upload
does not yet exist; it never invents a version ID.

## Cutover and rollback

Follow [the production release runbook](../../docs/transcription-production-release.md)
for seed, plan and rollback commands. Back up OpenTofu state in its existing
bucket first. Never modify the original state or use a destroy/nuke command.
The seed boundary rejects unknown resources, ambiguous/deposed instances,
unexpected modules, changed live configuration and conflicting destination state.
`--dry-run` does not open the Alchemy state store or write state, including locks.
An interrupted seed can resume only when its completed records still match.

The normal release driver acquires a state lease even for a plan dry run; it
makes no product changes. Python pin retention reads the pinned DynamoDB output
encoding directly, including its S3 overflow form, without installing Node,
bootstrapping state or acquiring a lease. Do not run it against unseeded production as a probe.
Use the seed dry-run for production preparation. After seeding, expect all 13
(or 14) resources to plan as no-ops. A successful run-owned deploy/release/no-op/destroy proof is required before production cutover; see [the proof command](../migration/README.md#ephemeral-release-gate-for-production-cutover).

## Run-owned lifecycle

Only ephemeral stages may create or delete the Lambda. Their function and every
other owned resource name derive from the stage; production creation/deletion
remain forbidden. The provider selects the exact versioned ZIP and verifies
its SHA and full configuration after creation. The release proof claims an empty
stage under its lease before applying, so a stage-name collision cannot trigger
cleanup of another run. Partial creation is cleaned in `finally`.
