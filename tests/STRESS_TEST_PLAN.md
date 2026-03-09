# Chalk Stress Test Plan

## Status: Ready for Execution (k6 complete; Artillery/WebRTC optional)

---

## Completed (Phase 1: Infrastructure Setup)

All test files have been created and are ready to use:

### k6 Test Scripts

- [x] `tests/load/k6/config.js` - Shared config (BASE_URL, WS_URL, thresholds, tenant info)
- [x] `tests/load/k6/helpers/auth.js` - Token generation (getAuthToken, refreshToken)
- [x] `tests/load/k6/helpers/websocket.js` - WS message types matching API's messages.go
- [x] `tests/load/k6/scenarios/smoke.js` - Baseline verification (10 VUs, 1m)
- [x] `tests/load/k6/scenarios/room-creation.js` - Room creation storm (scaled by `K6_ACTIVE_USERS`, default 3000)
- [x] `tests/load/k6/scenarios/participant-churn.js` - Join/leave churn (scaled by `K6_ACTIVE_USERS`, default 3000)
- [x] `tests/load/k6/scenarios/large-room.js` - Large room join + broadcast (scaled by `K6_ACTIVE_USERS`, default 3000)
- [x] `tests/load/k6/scenarios/ws-storm.js` - Message flood rate limit test (scaled by `K6_ACTIVE_USERS`, default 3000)

### Artillery WebSocket Scenarios

- [x] `tests/load/artillery/config.yml` - Base configuration
- [x] `tests/load/artillery/websocket-chat.yml` - Chat message load test
- [x] `tests/load/artillery/websocket-whiteboard.yml` - Whiteboard sync scenarios
- [x] `tests/load/artillery/functions.js` - Custom JS helpers

### Go WebRTC Load Client

- [x] `tests/load/webrtc-client/go.mod` - Go 1.22 with pion/webrtc, prometheus
- [x] `tests/load/webrtc-client/main.go` - CLI with Prometheus metrics endpoint

### Terraform Infrastructure

- [x] `tests/infrastructure/terraform/stress-test/main.tf` - Full AWS setup
- [x] `tests/infrastructure/terraform/stress-test/variables.tf` - Config variables
- [x] `tests/infrastructure/terraform/stress-test/outputs.tf` - Endpoint outputs

### Execution Scripts

- [x] `tests/scripts/setup-test-env.sh` - Provision infrastructure + create tenant
- [x] `tests/scripts/run-tests.sh` - Execute k6 scenarios with auto-result logging
- [x] `tests/scripts/cleanup.sh` - Destroy infrastructure
- [x] `tests/scripts/append-results.sh` - Auto-append k6 JSON to markdown
- [x] `tests/scripts/append-custom-result.sh` - Manual result entry
- [x] `tests/scripts/generate-summary.sh` - Summary report generator

### Results Framework

- [x] `tests/results/STRESS_TEST_RESULTS.md` - Persistent results file (initialized)

---

## Next Steps (Phase 2: Execution)

### Prerequisites

1. **AWS credentials configured** - `aws configure` or `AWS_PROFILE=q9labs`
2. **Terraform state bucket exists** - `chalk-terraform-state` in us-east-1
3. **k6 installed locally** - `brew install k6`
4. **jq installed** - `brew install jq`
5. **Docker installed** - for building the API image
6. **AWS CLI installed** - for ECR/ECS operations

### Day 1: Infrastructure Setup

```bash
# 1. Review and customize Terraform variables
cd tests/infrastructure/terraform/stress-test
cp terraform.tfvars.example terraform.tfvars  # Create if needed
# Edit: db_username, db_password, cloudflare_* (and optional sizing)

# 2. Provision infrastructure + push API image to ECR
AWS_PROFILE=q9labs ./tests/scripts/setup-test-env.sh

# 3. Verify outputs
# - API endpoint URL
# - Load generator IPs
# - CloudWatch dashboard URL
# - Test tenant credentials saved to tests/load/k6/.env
```

### Day 1: Smoke Test

```bash
# Run baseline verification
K6_SHORT=false K6_ACTIVE_USERS=3000 ./tests/scripts/run-tests.sh smoke

# Expected: All checks pass, p95 < 500ms, 0% errors
# Results auto-appended to tests/results/STRESS_TEST_RESULTS.md
```

### Day 2-3: Load Tests

```bash
# Room creation storm (scaled by K6_ACTIVE_USERS)
K6_SHORT=false K6_ACTIVE_USERS=3000 ./tests/scripts/run-tests.sh room-creation

# Participant join/leave churn
K6_SHORT=false K6_ACTIVE_USERS=3000 ./tests/scripts/run-tests.sh participant-churn

# Check CloudWatch dashboard between tests
# Cool down 60 seconds between scenarios
```

### Day 4-5: Stress Tests

```bash
# Large room (scaled by K6_ACTIVE_USERS)
K6_SHORT=false K6_ACTIVE_USERS=3000 ./tests/scripts/run-tests.sh large-room

# WebSocket message flood (rate limit verification)
K6_SHORT=false K6_ACTIVE_USERS=3000 ./tests/scripts/run-tests.sh ws-storm
```

### Day 6: Spike Testing (Manual)

```bash
# Custom k6 run with spike pattern
k6 run \
  -e BASE_URL="$BASE_URL" \
  -e TENANT_ID="$TENANT_ID" \
  -e API_KEY="$API_KEY" \
  --vus 200 \
  --duration 30s \
  tests/load/k6/scenarios/room-creation.js
```

### Day 7-8: Endurance Testing

```bash
# Extended duration run (4+ hours)
k6 run \
  -e BASE_URL="$BASE_URL" \
  -e WS_URL="$WS_URL" \
  -e TENANT_ID="$TENANT_ID" \
  -e API_KEY="$API_KEY" \
  --duration 4h \
  tests/load/k6/scenarios/participant-churn.js

# Monitor for memory leaks via CloudWatch
```

### Day 8: Cleanup & Report

```bash
# Generate summary
./tests/scripts/generate-summary.sh

# Review results
cat tests/results/SUMMARY.md
cat tests/results/STRESS_TEST_RESULTS.md

# Cleanup infrastructure
./tests/scripts/cleanup.sh
```

---

## Acceptance Criteria

| Metric                          | Threshold | Test Scenario     |
| ------------------------------- | --------- | ----------------- |
| Room creation p95               | < 1s      | room-creation     |
| Participant join p95            | < 2s      | participant-churn |
| Chat broadcast p95              | < 500ms   | large-room        |
| Large room (100+) broadcast p95 | < 1s      | large-room        |
| Rate limiter accuracy           | 100%      | ws-storm          |
| Error rate                      | < 1%      | all scenarios     |
| Memory growth (4hr)             | < 20%     | endurance         |

---

## Monitoring During Tests

### CloudWatch Dashboard

URL output from Terraform: `cloudwatch_dashboard_url`

Widgets:

- ECS CPU & Memory utilization
- Aurora connections & ACU scaling
- Redis CPU & memory
- ALB request count & p95 latency

### Manual Checks

```bash
# Tail API logs
aws logs tail /chalk-stress/api --follow

# Check ECS task count
aws ecs describe-services \
  --cluster chalk-stress-cluster \
  --services chalk-stress-api \
  --query 'services[0].runningCount'

# Check Aurora ACU
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name ServerlessDatabaseCapacity \
  --dimensions Name=DBClusterIdentifier,Value=chalk-stress-db \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 \
  --statistics Average
```

---

## Troubleshooting

### Common Issues

**k6: "connection refused"**

- Check API endpoint is correct in `.env`
- Verify ECS tasks are running
- Check security group allows traffic

**Terraform: "VPC not found"**

- Update `data.aws_vpc.main` tags in main.tf to match your VPC

**High error rate**

- Check CloudWatch logs for specific errors
- May need to increase Aurora ACU max or ECS task count

**Rate limiting not working**

- Verify Redis is connected (check API logs)
- Check `ws-storm` threshold expects >40% rate limited

### Adjusting Test Parameters

Edit scenario files directly:

- `stages` array for ramp patterns
- `vus` / `duration` for simple tests
- `thresholds` for pass/fail criteria

---

## Files Reference

```
tests/
├── load/
│   ├── k6/
│   │   ├── config.js
│   │   ├── helpers/{auth,websocket}.js
│   │   └── scenarios/{smoke,room-creation,participant-churn,large-room,ws-storm}.js
│   ├── artillery/
│   │   ├── config.yml
│   │   ├── websocket-{chat,whiteboard}.yml
│   │   └── functions.js
│   └── webrtc-client/
│       ├── go.mod
│       └── main.go
├── infrastructure/terraform/stress-test/
│   ├── main.tf
│   ├── variables.tf
│   └── outputs.tf
├── scripts/
│   ├── setup-test-env.sh
│   ├── run-tests.sh
│   ├── cleanup.sh
│   ├── append-results.sh
│   ├── append-custom-result.sh
│   └── generate-summary.sh
├── results/
│   └── STRESS_TEST_RESULTS.md
└── STRESS_TEST_PLAN.md  ← This file
```
