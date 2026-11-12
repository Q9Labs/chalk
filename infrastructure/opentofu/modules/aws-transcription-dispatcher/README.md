# AWS transcription dispatcher module

Declares the environment-scoped, scale-to-zero transcription dispatcher. It does not bootstrap an AWS account, create a state backend, upload a ZIP or mutate a production release. The caller supplies the existing versioned artifact bucket, exact S3 object version, ZIP SHA-256, SSM parameter ARNs and alarm destinations.

**Providers fail closed.** Both provider flags default to false until a release supplies privacy acceptance and a qualification corpus digest, which must identify a genuine passing corpus, not a synthetic smoke. The cost-first target enables direct DeepInfra and leaves `cloudflare_enabled = false`. Only enabled providers need credentials, appear in the SSM IAM allowlist or appear in `required_egress_destinations`, which is an inventory, not a network-enforced allowlist. Execution-identity and model-version pins are optional assertions against metadata actually observed, not invented attestations.

**Artifact identity.** The ZIP is selected by bucket, immutable key, object version and `source_code_hash`. A key containing `latest`, or one that lacks `release_id`, is rejected. `release_manifest_digest` and `config_digest` are exposed as outputs and injected as non-secret runtime identity. `CONTROL_API_AUDIENCE` is a non-secret release input for the workload HMAC signer, never a credential.

**Secrets.** Provider tokens and the API workload credential stay SSM SecureStrings. The Lambda gets only their ARNs and fetches them at cold start; the execution policy can read only those parameters and decrypt only the caller's listed KMS keys. It has no database, reusable R2 or infrastructure-mutation permission. Disabled-provider ARNs and unset pins are omitted from the environment instead of set empty.

**Timing.** `timeout_seconds - work_budget_seconds` is a plan-time invariant of at least 60 seconds, reserved for response validation, result upload and lease completion. Reserved concurrency (3 to 50) lets the one-minute reconciliation serve transcription, finalization and cleanup queues in one invocation. EventBridge Scheduler wakes reconciliation every minute, with its own retry policy and DLQ; terminal async failures go to an SQS destination.

**Activation.** `scheduler_state` is required with no default. Keep it `DISABLED` while the transcript-first API release, the shared workload secret and the API runtime's invoke policy are prepared, then switch to `ENABLED` in one coordinated activation. The module outputs `control_api_invoke_policy_json` for the separately owned API runtime role; it never mutates that role.

**A wake is only a hint.** Async Lambda acceptance is a 202, payloads are limited to 1 MiB, and AWS may duplicate or drop a wake. The dispatcher relies on the recorder API's fenced compare-and-set lease and the schedule, not on an invocation as durable job state.

**No false monitor.** `infrastructure/uptime-worker` only probes HTTP URLs, which would stay green while a fenced PostgreSQL job, provider call or result commit was broken. A deployment integration must supply a synthetic control/API URL before the registry can honestly represent this component.

**Network.** The Lambda uses default internet access with no VPC attachment, so it needs no NAT gateway, proxy or VPC endpoint, and the control API must be reachable over authenticated public HTTPS. DeepInfra-only selection is enforced by application configuration and the direct adapter (redirects rejected), not by a firewall, so it is no sandbox against a compromised function. Do not restore a VPC attachment or add recurring networking resources without an explicit deployment decision.
