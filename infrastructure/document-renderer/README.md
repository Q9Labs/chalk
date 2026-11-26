# Document renderer

This stack deploys the presenting document renderer, a Lambda that turns a
presented document into page images. It is run-owned: the registry marks it `ephemeral`, so
only ephemeral stages may create it. No seeded or always-on environment exists yet.
The entrypoint is `infrastructure/document-renderer/alchemy.run.ts`; the stage
selects the environment, and the implementation is the same for every stage.
The renderer code itself lives in [`apps/document-renderer`](../../apps/document-renderer/README.md),
which also documents the threat model.

## Resources and inputs

The stack manages seven resources: a CloudWatch log group, a metric filter for
reported render invocation failures, an execution role with one inline policy,
the versioned Lambda function, and three alarms (`Errors`, `Throttles` and
`AsyncEventsDropped`). An eighth, the `ControlApiPermission` that lets the
control API invoke the function, exists only when both control API permission
inputs are set. The `Errors` alarm uses the metric filter rather than Lambda's
`Errors` metric because the renderer deliberately exits after every job to reset
its execution environment, and Lambda counts even a successful deliberate recycle
as a runtime error. The function is `provided.al2023` on arm64 with the
`bootstrap` handler, active X-Ray tracing, and no VPC configuration, so it uses
default Lambda networking.

[`config.ts`](config.ts) validates the inputs before planning. The function name
must match `^[a-z0-9-]{8,64}$`, the artifact key must contain the release ID, and
the hexadecimal and base64 SHA-256 values must agree. Memory must be an integer
from 1024 to 10240 MB, the timeout from 60 to 900 seconds, and reserved concurrency
from 1 to 64. Asynchronous invocation configuration is explicit: Lambda retries
are fixed at zero because presenting leases and reconciliation own retries, and
the maximum event age is fixed at 300 seconds. The two control API permission
fields must be set together or not at all. An ephemeral stage must derive its
function name from the stage.

Inputs come from one of two places. A deploy with `CHALK_INFRA_INPUTS` reads that
JSON file. Otherwise the stack reads the redacted `renderer_inputs` output stored
in state, and it fails if neither source exists. The input file holds release
identifiers and control API settings, so keep it private: it does not belong in
Git or CI artifacts.

[`environment.ts`](environment.ts) builds the function environment from the release
and config digests and the control API base URL. It also sets `LD_LIBRARY_PATH`
to `/var/task/lib`, the library path inside the Lambda package.

[`resources.ts`](resources.ts) builds the props for each resource. The execution
role can only write its own log group's streams. It cannot read object storage,
which is why the renderer depends on short-lived, per-job pre-signed URLs rather
than ambient credentials.

## Outputs

The stack exports the function ARN, the execution role ARN, the log group name,
the artifact and release identities, and `control_api_invoke_policy_json`. That
last output is the policy the control API's role needs to invoke this function.
The stack emits it but does not attach it to any role.
`required_egress_destinations` lists the control API and job-scoped pre-signed
object storage. It is an inventory, not a network-enforced allowlist.

## Release safety

[`../releases/deploy.ts`](../releases/deploy.ts) checks the plan before apply.
For an ephemeral stage, the bootstrap check requires that the stage has no
existing resources or outputs, and that the plan creates exactly the isolated
resource set (the optional permission excluded). Any other action, deletion or
pre-existing state refuses the run. The driver never claims a stage that already has state.

## Ownership and cleanup

Only ephemeral stages may create or delete this stack. Its function and other
owned resource names derive from the stage name. The release driver checks that
the stage is empty before it applies anything, so a stage-name collision cannot
trigger cleanup of another run.
