# Transcription dispatcher

This stack replaces the dispatcher OpenTofu module for Nightly and production.
`@chalk/infrastructure` pins Alchemy and its AWS provider to `2.0.0-beta.87`.
The entrypoint is `infrastructure/nightly/transcription/alchemy.run.ts`; the stage
selects the environment, not a different implementation.

## Resources and inputs

The stack keeps the existing Lambda, two SQS queues and their policies, two IAM
roles and their inline policies, log group, one-minute schedule, Lambda invoke
permissions, asynchronous failure destination and five alarms. Inline policies,
queue policies and event-invoke configuration are folded into their owning
Alchemy resources. Thirteen resources are managed when the optional control API
permission is absent; fourteen when it is present. Existing physical names,
tags, SSE-SQS and the queues' 256 KiB message limit are preserved.

`inputs.ts` checks the former module's validations and preconditions before
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
replaces the generated temporary `main.tf.json` root and tfvars. Release commands
refuse an environment that has not been explicitly seeded. They never fall back
to OpenTofu state. Keep input JSON, detailed plans, state exports and diagnostics
private; none belongs in Git or CI artifacts.

## Release safety

`driver.ts` uses `Alchemist.plan` and holds the state lease while Python checks
the detailed plan over a private stdin/stdout protocol. Only the exact line
`approve` applies the same in-memory plan with `Alchemist.apply`. EOF, rejection,
unknown properties, Actions and binding mutations fail closed. A second plan
uses the same state context; it must contain only no-ops. Rebuilding the state
layer for that check would contend with the still-held stage lease.

Python compares **stored desired props** with **new desired props**, not live
Terraform attributes. Binding allows only release metadata and the immutable
object location; media releases additionally allow the exact new ZIP hash,
manifest/corpus digests and scheduler activation. MAI configuration allows only
its environment-scoped secret grant, selection variables and configuration
digest. Full-stack resource/type, input and output allowlists reject partial
plans, creates, adoption, replacement, deletion and unrelated changes. Before
approval the driver also runs read-only drift detection against persisted live
attributes. This is a separate live-state check, not Terraform's refresh plan;
it covers only fields each provider observes, not every Terraform-refreshed
attribute. In particular, native SQS reads only explicitly managed attributes;
unset optional attributes such as redrive policies are outside that live check.
Known queue defaults are explicit props. Alarm evaluation state and timestamps
are excluded, while alarm configuration remains checked.

The focused Lambda provider passes bucket, key and object version directly to
AWS. It never bundles or publishes a Lambda version. The deployed `CodeSha256`
must equal the artifact digest, and configuration is read back after apply.
Alchemy's native Lambda provider only accepts a bundle or image. Its generic
Cloud Control provider can express S3 code, but treats the write-only `Code`
properties as ordinary observable fields and cannot prove the deployed digest.

A media dry run verifies the candidate ZIP bytes and a current-state no-op plan.
It cannot preview the final release plan before upload supplies a real destination
object version. It returns `preflight_only: true` and never invents a version or
approves a plan. Normal deploys check the complete post-upload plan before apply.

## Cutover and rollback

Follow [the production release runbook](../../../docs/transcription-production-release.md)
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
(or 14) resources to plan as no-ops. Nightly's no-op cutover and dry-run are not a
substitute for a real Nightly release before production cutover.
