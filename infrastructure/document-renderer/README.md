# Document renderer

This stack deploys the presenting document renderer, a Lambda that turns a
presented document into page images. Ephemeral `nightly-<run-id>` stages are run-owned. Production is
Alchemy-owned after a one-time bootstrap; see Release safety below.
The entrypoint is `infrastructure/document-renderer/alchemy.run.ts`; the stage
selects the environment, and the implementation is the same for every stage.
The renderer code itself lives in [`apps/document-renderer`](../../apps/document-renderer/README.md),
which also documents the threat model.

## Resources and inputs

The ZIP stack manages seven resources (the image stack has the same set under its own names): a CloudWatch log group, a metric filter for
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
from 1 to 64. The two control API permission fields must be set together or not
at all. An ephemeral stage must derive its function name from the stage.

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
The stack always emits it. When `control_api_invoker_role_name` is set, the stack
also attaches it to that existing role as the inline policy named
`<function_name>-control-api-invoke` (the Alchemy resource is `ControlApiInvokePolicy`);
otherwise the role owner must attach it.
`required_egress_destinations` lists the control API and job-scoped pre-signed
object storage. It is an inventory, not a network-enforced allowlist.

## Release safety

[`../releases/deploy.ts`](../releases/deploy.ts) checks the plan before apply.
For an ephemeral stage, the bootstrap check requires that the stage has no
existing resources or outputs, and that the plan creates exactly the isolated
resource set (the optional permission excluded). Any other action, deletion or
pre-existing state refuses the run. The driver never claims a stage that already has state.

## Ownership and cleanup

Only ephemeral stages may create or delete run-owned resources. Production is
created once by the bootstrap command and changed afterwards only by the release
driver. Function and other owned resource names derive from the stage name. The release driver checks that
the stage is empty before it applies anything, so a stage-name collision cannot
trigger cleanup of another run.

## Release safety

Production is Alchemy-owned after a one-time explicit bootstrap. Its records and
redacted inputs live under `document-renderer/production`; afterwards every
release goes through `releases/renderer-driver.ts`. The driver keeps the stage
lease, projects the complete plan, checks the closed release policy, applies the
same in-memory plan, verifies the exact ZIP hash and requires a no-op second
plan. It refuses creates, replacements, deletes, unrelated inputs or outputs and
unseeded production state.

Only ephemeral `nightly-<run-id>` stages may create or delete the Lambda and its
owned resources. Their function name is `chalk-<stage>-document-renderer`. The
run-owned provider stamps and checks ownership before cleanup. Never run a
destroy or nuke command against production.

## Container-image renderer

Office conversion needs LibreOffice, which does not fit the 250 MB ZIP limit, so the renderer also ships as a
container image. The image function is a second stack, `document-renderer-image`, next to the untouched ZIP stack:
it has its own Alchemy state, execution role, log group, alarms and function
(`chalk-<stage>-document-renderer-image`). Neither stack changes the other. Which function serves traffic is a
config value: the API's `CHALK_PRESENTING_RENDERER_FUNCTION_NAME`, which names the ZIP function until the image
path is approved.

- **Inputs.** Image inputs carry `package_type: "image"`, `image_repository_uri` (an ECR repository URI) and
  `image_digest` (`sha256:<64 hex>`) instead of the `artifact_*` fields. The function runs
  `<repository>@<digest>`; tags are never deployed. Memory must be at least 3072 MB, because soffice needs it.
  The function has no runtime or handler: the image's entrypoint is the Go bootstrap, which speaks the Lambda
  Runtime API directly. `LD_LIBRARY_PATH` is `/opt/renderer/lib`.
- **Image.** [`apps/document-renderer/image/Dockerfile`](../../apps/document-renderer/image/Dockerfile) builds on
  Debian trixie (not the AWS base image), pinned by index digest, with apt packages frozen by a
  `snapshot.debian.org` timestamp. It holds the Go bootstrap, the pinned PDFium and libwebp,
  LibreOffice (Impress, Writer, Calc and `python3-uno`, no Java), the bundled fonts and
  `/opt/renderer/office-convert.py`. It runs as uid 10001 with a read-only root; only `/tmp` is writable, which is
  Lambda's rule anyway. `/opt/renderer/packages.txt` lists every installed package version.
- **Build.** `scripts/build-document-renderer-image.sh` writes a single-manifest OCI archive and
  `image-manifest.json` (digest, platform, layer sizes, PDFium pin). Run it on Linux with Docker buildx; it builds
  arm64 by default and `RENDERER_IMAGE_PLATFORM=linux/amd64` builds a native x86 image for a quick proof. The digest
  is not bit-reproducible (the font caches embed timestamps), so the pipeline builds once, pushes that archive and
  deploys the digest it recorded.
- **ECR repository.** `ecr/apply-ecr-repository` creates `chalk-document-renderer` with immutable tags, scan on
  push, AES-256 encryption, a lifecycle policy (untagged images expire after a day; the 20 newest images stay) and a
  repository policy that lets Lambda pull for `chalk-*-document-renderer-image` functions. `--check` exits 1 on
  drift. Rollback depth is therefore the last 20 images; raise the count in `ecr/lifecycle-policy.json` to keep more.
  `ecr/test-ecr-and-deploy-role.sh` proves both apply scripts offline with a fake `aws`.
- **Release.** CI builds and pushes the image only when the repository variable
  `CHALK_RENDERER_IMAGE_RELEASE_ENABLED` is `true`. `media.py publish_renderer_image` copies the archive to ECR with
  the digest preserved and records `renderer_image` (repository, digest) in the media members.
  `media.py deploy_renderer_image` runs `releases/renderer-image-driver.ts` with the recorded digest and then
  checks Lambda's resolved image URI, state and release tag. The ZIP path is unchanged and still runs first.
- **Bootstrap.** The first production deploy of the image function is a one-time bootstrap like the ZIP one:
  `pnpm infra bootstrap document-renderer-image production` with the same approval variable, and inputs that name
  the ECR repository and a recorded digest. Never run it before `ecr/apply-ecr-repository` and the deploy-role
  policy (`nightly/deploy-role/apply-document-renderer-publish`) are applied.

## Bootstrap and rollback

A brand-new production capability has no former OpenTofu state to import. The
one-time bootstrap command is deliberately separate from normal releases:

```sh
AWS_PROFILE=q9labs CHALK_INFRA_INPUTS=/private/document-renderer-production.json \
  CHALK_DOCUMENT_RENDERER_PRODUCTION_BOOTSTRAP=approved \
  pnpm infra bootstrap document-renderer production
```

The bootstrap refuses an existing stage, validates the complete create-only
renderer graph, writes the state/output a first deploy writes, then converges.
After it succeeds, use only the managed release path. Ownership rollback is an
operator incident: save state privately, delete the AWS resources explicitly,
then delete the Alchemy stage state. Never run both infrastructure owners.

Rolling back renderer code uses the prior managed release manifest and media
members. Promote copies exact versioned ZIP bytes; it never rebuilds them.

### Rolling back from the image to the ZIP renderer

The ZIP function stays deployed and current until the image path has shipped once, so the fastest undo is a config
change, not a deploy.

1. Set `CHALK_PRESENTING_RENDERER_FUNCTION_NAME=chalk-production-document-renderer` in the production SSM runtime
   inputs and ship it with the next managed release (see [incident.md](../../docs/operators/incident.md)). The API
   then invokes the ZIP function again; nothing in AWS changes.
2. To stop the image path from deploying, unset the `CHALK_RENDERER_IMAGE_RELEASE_ENABLED` variable on the
   production and nightly GitHub environments. The next Promote then records `renderer-image-not-declared` and leaves
   the image function untouched.
3. To roll the image function itself back, promote the previous release: its media members hold the previous
   `renderer_image` digest, and `deploy_renderer_image` deploys that digest through the same checked driver. The
   digest must still exist in ECR (the lifecycle keeps the last 20).
4. Only after the image has served production for a full release cycle, retire the ZIP path in a separate change.
   Never delete the ZIP function, its state or its S3 objects as part of the image rollout.

Presenting itself can still be turned off without any of this by the database kill switch in
[incident.md](../../docs/operators/incident.md#turn-off-presenting).
