# Whisper Worker Ops Guide

## Overview
- Service: whisper transcription worker (CPU/GPU; faster-whisper)
- Queue key: `transcription:jobs`
- Result key: `transcription:result:{job_id}` (TTL 24h)
- Axiom dataset: `chalk-api-prod` (shared prod dataset; env `AXIOM_DATASET`)
- Log file: `/var/log/whisper-worker.log`
- CloudWatch log group: `/aws/ec2/chalk-whisper-<env>`
- Metrics namespace: `Chalk/Whisper` (dimension `Environment`)
  - Queue: `TranscriptionQueueDepth`, `TranscriptionJobQueueDepth`, `TranscriptionProcessingQueueDepth`, `QueueWaitMs`
  - Throughput: `TranscriptionsTotal`, `TranscriptionsCompleted`, `TranscriptionsFailed`
  - Timing: `ProcessingTimeSeconds`, `AudioDurationSeconds`, `RtfRatio`, `TranscriptionDurationMs`
  - Runtime (GPU nodes): `GpuUtilizationPercent`, `GpuMemoryUtilizationPercent`, `GpuDeviceCount`

## Deploy (Prod Lean)
1. Make code/infra changes in `infrastructure/whisper-worker` and/or `infrastructure/terraform`.
2. Run gate locally:
   - `bun run lint`
   - `bun run check-types`
   - `bun run test`
   - `bun run --cwd apps/docs build`
   - `cd infrastructure/terraform && terraform fmt -check -recursive`
   - `cd infrastructure/terraform/environments/prod-lean && AWS_PROFILE=q9labs AWS_REGION=us-east-1 terraform init -input=false && terraform validate`
   - `python3 -m py_compile infrastructure/whisper-worker/*.py`
3. Update `CHANGELOG.md` under `[Unreleased]`.
4. Commit (Conventional Commits) and push to `master`.
5. Build image: `gh workflow run whisper-worker.yml` and wait for green.
6. Apply infra: `gh workflow run infra-lean.yml -f action=apply` and wait for green.
7. Roll instances:
   - `aws --profile q9labs --region us-east-1 autoscaling start-instance-refresh --auto-scaling-group-name <asg> --preferences MinHealthyPercentage=0,InstanceWarmup=300`

## Runtime Env Vars
- `REDIS_URL` from Secrets Manager (auth token). Injected via user-data.
- `AXIOM_TOKEN` from Secrets Manager `chalk/<env>/axiom` (seeded by SSM `/chalk/prod/axiom-token`).
- `AXIOM_DATASET` set by Terraform (`chalk-api-prod`).
- `AXIOM_DOMAIN` set by Terraform (`api.axiom.co`).
- `AXIOM_TRACES_DATASET` set by Terraform (`chalk-prod-traces`).
- `ENVIRONMENT` from Terraform (`prod-lean`).
- `LOG_LEVEL` defaults to `INFO` unless overridden.
- `WHISPER_CHUNK_LENGTH_SECONDS` controls segment/window size for language detection.
  - Default: `15` when `WHISPER_MULTILINGUAL=true`
  - Set to `0`/empty/invalid to fall back to model defaults (no override)
- `WHISPER_CONDITION_ON_PREVIOUS_TEXT` controls prompt carryover between segments.
  - Default: `false` when `WHISPER_MULTILINGUAL=true` (better code-switching)
  - Default: `true` when `WHISPER_MULTILINGUAL=false`
- `WHISPER_LANGUAGE_DETECTION_SEGMENTS` number of segments to consider for initial language detection (default: `1`).
- `WHISPER_LANGUAGE_DETECTION_THRESHOLD` min probability to accept detected language (default: `0.5`).
- `REDIS_CONNECT_TIMEOUT` socket connect timeout in seconds (default: `5`).
- `REDIS_SOCKET_TIMEOUT` command socket timeout in seconds (default: `POLL_TIMEOUT_SECONDS + 5`).
  - Must be greater than `POLL_TIMEOUT_SECONDS` to avoid BRPOP read timeouts.
- `REDIS_RETRY_ON_TIMEOUT` retry commands on timeout (default: `true`).
- `REDIS_HEALTHCHECK_INTERVAL` seconds between health checks (default: `30`).
- Transcript logging is disabled in prod (no raw transcript in Axiom logs).

## Observability
- Axiom events:
  - `worker.start`
  - `whisper.queue_depth`
  - `whisper.transcription` (success/error)
  - `metrics.gpu_publish_failed`
  - `metrics.publish_failed` (CloudWatch queue metric publish failures)
  - `worker.unexpected_error`
- `traceparent` from queued jobs is used to continue distributed traces from the API.
- Axiom ingest failures no longer block jobs; events fall back to stdout JSON.

## Quick Health Checks (SSM)
- Container status:
  - `docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"`
- Logs:
  - `tail -n 200 /var/log/whisper-worker.log`
  - `docker logs --tail 200 whisper-worker`
- Env:
  - `docker exec whisper-worker env | egrep "AXIOM|ENVIRONMENT|WHISPER_LOG_TRANSCRIPT"`
- Redis ping:
  - `docker exec whisper-worker python -c 'import os, redis; r=redis.from_url(os.environ["REDIS_URL"], decode_responses=True, socket_connect_timeout=2, socket_timeout=2); print(r.ping())'`
- Axiom ingest smoke:
  - `docker exec whisper-worker python -c 'import os, axiom_py; c=axiom_py.Client(); ds=os.environ.get("AXIOM_DATASET",""); print(c.ingest_events(ds, [{"event":"axiom-smoke"}]))'`

## Troubleshooting
- `metrics.publish_failed` + Axiom 404:
  - Dataset name mismatch. Confirm `AXIOM_DATASET` and dataset exists in Axiom.
- Axiom 403:
  - Token lacks permissions. Use token with ingest permissions for `AXIOM_DATASET`.
- Redis timeouts:
  - Security group ingress missing on Redis SG.
  - Terraform resource: `aws_security_group_rule.redis_from_whisper`.
  - If Terraform drifted, re-apply or add rule with AWS CLI and then reconcile state.
- Worker not starting:
  - Check `/var/log/cloud-init-output.log` for user-data errors.
  - Validate `AXIOM_TOKEN` and `REDIS_URL` from Secrets Manager.

## Notes
- Do not log full `audio_url`. Only scheme/host is recorded.
- High-cardinality `job_id` is expected in Axiom.
