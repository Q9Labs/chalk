---
name: chalk-stress-testing
description: Provision Chalk stress infra + run prod-parity k6 sweeps (200→750 VUs) with reproducible artifacts and teardown.
---

# Chalk Stress Testing Skill (Codex)

Goal: repeatable stress testing for Chalk without repo churn, lost state, or mystery knobs.

This skill assumes Chalk’s stress tooling lives under `tests/` and that we **do not upscale infra mid-test** (reality check).

## Where things live

- Infra: `tests/infrastructure/terraform/stress-test/`
- Provision + deploy API image: `tests/scripts/setup-test-env.sh`
- Run single scenario(s): `tests/scripts/run-tests.sh`
- Run capacity sweep: `tests/scripts/run-sweep.sh`
- k6 scenarios: `tests/load/k6/scenarios/*.js`
- Results:
  - Append-only log: `tests/results/STRESS_TEST_RESULTS.md`
  - Sweep index: `tests/results/SWEEP_RESULTS.md`
  - Per-run artifacts: `tests/results/<scenario>-<timestamp>.jsonl` + `<scenario>-<timestamp>-summary.json`

## Preconditions (operator)

- AWS CLI configured with profile `q9labs`
- Region: `us-east-1`
- Tools: `terraform`, `docker`, `k6`, `jq`, `bc`
- Cloudflare env vars available to the API (do **not** store tokens in repo)

## Runbook (prod-parity sweep)

### 1) Provision/apply infra + deploy API

```bash
AWS_PROFILE=q9labs AWS_REGION=us-east-1 ./tests/scripts/setup-test-env.sh
```

Outputs are printed by the script (API endpoint, CloudWatch dashboard, load-generator IPs).

### 2) Run sweep (200→750, +50)

```bash
K6_SWEEP_START=200 K6_SWEEP_END=750 K6_SWEEP_STEP=50 \
K6_SWEEP_SCENARIOS=large-room,ws-storm \
K6_SWEEP_LONG_POINTS=200,first-fail,750 \
K6_SWEEP_COOLDOWN_SECONDS=60 \
./tests/scripts/run-sweep.sh
```

Notes:

- `K6_SHORT=true` is used for each sweep step; `run-sweep.sh` triggers “long confirm” only at configured points.
- The sweep does **not** change infra sizing. Failures are data.

### 3) Tear down infra (after tests)

```bash
AWS_PROFILE=q9labs AWS_REGION=us-east-1 terraform -chdir=tests/infrastructure/terraform/stress-test destroy
```

## Interpreting failures (quick triage)

- `http_req_failed` high → API errors, auth, or backend dependency failures.
- `broadcast_latency` p95/p99 over threshold (large-room) → WS fanout/broadcast path bottleneck.
- `rate_limit_rate` high (ws-storm) → Cloudflare/WS rate limiting was hit (expected only if `K6_EXPECT_RATE_LIMIT=true`).

## Updating this skill (keep it evergreen)

When stress tooling changes, update this file in lockstep:

- New/renamed scripts → update the “Where things live” section.
- New env vars / knobs → add them to “Runbook” with defaults.
- Artifact naming changes → update the “Results” bullets.
- Terraform path/module rename → update provision/destroy commands.

Rule: if someone can’t run a sweep from scratch in <10 minutes, the skill is stale.
