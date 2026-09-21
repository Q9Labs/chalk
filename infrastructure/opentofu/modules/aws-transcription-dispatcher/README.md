# AWS transcription dispatcher module

This reusable module declares the environment-scoped, scale-to-zero
transcription dispatcher contract. It intentionally does not bootstrap an AWS
account, create a state backend, upload a ZIP, or mutate a production release;
the caller supplies the existing versioned artifact bucket, exact S3 object
version, ZIP SHA-256, SSM parameter ARNs, and alarm destinations.

Provider selection is explicit and fails closed. The cost-first target enables
direct DeepInfra and leaves `cloudflare_enabled = false`. Both provider flags
default to false until a release supplies privacy acceptance and a qualification
corpus digest. Only enabled providers require credentials, appear in the SSM
IAM allowlist, or appear in `required_egress_destinations`. That output is an
outbound service inventory, not a network-enforced allowlist.

DeepInfra uses the documented native multipart `audio` endpoint for
`openai/whisper-large-v3-turbo`, with adapter contract
`deepinfra-native-whisper-turbo.v1`. Execution-identity/model-version pins are
optional assertions against genuinely observed metadata, not invented release
attestations. Cloudflare fallback requires explicit enablement and its own
adapter/corpus/credentials. No OpenRouter provider-routing guarantee is used.
See the [native API](https://deepinfra.com/openai/whisper-large-v3-turbo/api).

The Lambda runs Node.js 22 on arm64 with a bounded timeout, memory, and `/tmp`
allocation. `timeout_seconds - work_budget_seconds` is a plan-time invariant of
at least 60 seconds, preserving time for response validation, result upload, and
lease completion. Reserved concurrency defaults to 50 and is bounded from 3 to
50 so the one-minute reconciliation can service transcription, finalization, and
cleanup queues in one invocation.

The ZIP is selected by S3 bucket, immutable object key, object version, and the
exact SHA-256 passed as `source_code_hash`; a key containing `latest` or a key
that does not contain `release_id` is rejected. `release_manifest_digest` and
`config_digest` are exposed as outputs and injected as non-secret runtime
identity. Provider tokens and the API workload credential remain SSM
SecureStrings. The Lambda receives only the exact SSM parameter ARNs in
`DEEPINFRA_TOKEN_PARAMETER_ARN`, `CLOUDFLARE_AI_TOKEN_PARAMETER_ARN`, and
`CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN`; the dispatcher must fetch and decrypt
those values at cold start. The execution policy can read only those three
parameter ARNs and, when needed, decrypt only the caller's listed SSM KMS keys.
It contains no
database, reusable R2, or infrastructure-mutation permission.

Disabled provider parameter ARNs and unset optional DeepInfra execution/model
pins are omitted from the Lambda environment, rather than represented by empty
values. A corpus digest is still required whenever a provider is enabled; it
must identify a genuine passing qualification corpus, not a synthetic smoke.

`CONTROL_API_AUDIENCE` is a separate non-secret release input. The dispatcher
passes it, along with `CHALK_ENVIRONMENT` and `CHALK_RELEASE_ID`, into the
replay-resistant workload HMAC signer; it is never treated as a credential.

Each asynchronous invocation is bounded to AWS's 0–2 retry and six-hour event
age limits and sends terminal failures to an SQS destination. EventBridge
Scheduler wakes reconciliation every minute with flexible windows disabled; its
target has an independent retry policy and DLQ. Lambda invoke permissions are
constrained to Scheduler and the optional caller-supplied control-plane
principal/source ARN. CloudWatch logs, Lambda/SQS/Scheduler failure metrics,
and alarms are provisioned without assuming a notification provider.

`scheduler_state` is required and has no default. Use `DISABLED` while the
transcript-first API release, shared workload secret, and the API runtime's
least-privilege invoke policy are being prepared. Switch it to `ENABLED` only
in the coordinated activation. The module outputs
`control_api_invoke_policy_json` for attachment to the existing API runtime
role; it does not guess or mutate that separately owned role.

The control-plane wake is only a bounded hint: async Lambda acceptance is a
202, payloads are limited to 1 MiB, and AWS may duplicate or drop a wake. The
dispatcher therefore relies on the recorder API's fenced compare-and-set lease
and the one-minute reconciliation schedule rather than treating an invocation
as durable job state.

The current `infrastructure/uptime-worker` registry only probes HTTP URLs. A
handler-only or HTTP probe would remain green while a fenced PostgreSQL job,
provider call, or result commit was broken, so this module does not add a false
transcription monitor. A deployment integration must provide an environment-
supplied, non-secret synthetic control/API URL (or a purpose-built external
artifact workflow) before the registry can honestly represent this component;
that is an integration blocker, not an IaC resource to invent here.

The dispatcher uses Lambda's default internet access without a customer VPC
attachment. It needs no NAT gateway, outbound proxy, private subnet, or VPC
endpoint. The control API must be reachable over authenticated public HTTPS;
the dispatcher has no direct database access. Object access remains scoped to
presigned URLs supplied by the control API.

DeepInfra-only selection is enforced by the application configuration and
direct provider adapter, with redirects rejected and Cloudflare fallback off.
This does not provide a network sandbox against a compromised function: there
is no additional destination-filtering firewall. Do not restore a VPC attachment
or provision recurring networking resources without an explicit deployment
decision.
