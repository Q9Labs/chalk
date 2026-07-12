# AWS transcription dispatcher module

This reusable module declares the environment-scoped, scale-to-zero
transcription dispatcher contract. It intentionally does not bootstrap an AWS
account, create a state backend, upload a ZIP, or mutate a production release;
the caller supplies the existing versioned artifact bucket, exact S3 object
version, ZIP SHA-256, SSM parameter ARNs, VPC egress, and alarm destinations.

The Lambda runs Node.js 22 on arm64 with a bounded timeout, memory, and `/tmp`
allocation. `timeout_seconds - work_budget_seconds` is a plan-time invariant of
at least 60 seconds, preserving time for response validation, result upload, and
lease completion. Reserved concurrency defaults to 50 and is validated never to
be zero because AWS drops asynchronous events when reserved concurrency is set
to zero.

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

When VPC attachment is enabled, the caller must supply private subnets and
security groups plus an external NAT firewall or HTTPS proxy. The allowlist
documents only the control API, DeepInfra, Cloudflare AI, SSM, KMS, and
telemetry; interface endpoints do not provide egress to the two provider APIs.
