#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TERRAFORM_DIR="$PROJECT_ROOT/tests/infrastructure/terraform/stress-test"
RESULTS_DIR="$PROJECT_ROOT/tests/results"
SNAPSHOT_FILE="$RESULTS_DIR/INFRA_CAPACITY_SNAPSHOTS.jsonl"

START_TIME="${1:-}"
END_TIME="${2:-}"
LABEL="${3:-manual}"

if [ -z "$START_TIME" ] || [ -z "$END_TIME" ]; then
  echo "Usage: $0 <start-time-utc> <end-time-utc> [label]" >&2
  echo "Example: $0 2026-02-12T18:00:00Z 2026-02-12T18:10:00Z sweep-vu-300" >&2
  exit 1
fi

command -v terraform >/dev/null 2>&1 || { echo "terraform not found" >&2; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "aws CLI not found" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq not found" >&2; exit 1; }

AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
AWS_PROFILE_NAME="${AWS_PROFILE:-${AWS_CLI_PROFILE:-}}"

mkdir -p "$RESULTS_DIR"

if ! terraform -chdir="$TERRAFORM_DIR" workspace select stress-test >/dev/null 2>&1; then
  echo "Warn: terraform workspace stress-test not found; using current workspace." >&2
fi

tf_output() {
  local name="$1"
  terraform -chdir="$TERRAFORM_DIR" output -raw "$name" 2>/dev/null || {
    echo "Missing terraform output: $name" >&2
    return 1
  }
}

ECS_CLUSTER_NAME="$(tf_output ecs_cluster_name)"
ECS_SERVICE_NAME="$(tf_output ecs_service_name)"
ALB_ARN_SUFFIX="$(tf_output alb_arn_suffix)"
TARGET_GROUP_ARN_SUFFIX="$(tf_output target_group_arn_suffix)"
AURORA_CLUSTER_IDENTIFIER="$(tf_output aurora_cluster_identifier)"
REDIS_REPLICATION_GROUP_ID="$(tf_output redis_replication_group_id)"

cw_metric() {
  local namespace="$1"
  local metric_name="$2"
  local statistic="$3"
  local period="$4"
  local start_time="$5"
  local end_time="$6"
  shift 6

  local cmd=(
    aws cloudwatch get-metric-statistics
    --namespace "$namespace"
    --metric-name "$metric_name"
    --start-time "$start_time"
    --end-time "$end_time"
    --period "$period"
    --statistics "$statistic"
    --dimensions "$@"
    --region "$AWS_REGION"
    --output json
  )

  if [ -n "$AWS_PROFILE_NAME" ]; then
    cmd+=(--profile "$AWS_PROFILE_NAME")
  fi

  local raw
  raw="$("${cmd[@]}" 2>/dev/null || echo '{"Datapoints":[] }')"

  if [ "$statistic" = "Sum" ]; then
    jq -r "[.Datapoints[].Sum] | if length == 0 then 0 else add end" <<<"$raw"
  elif [ "$statistic" = "Average" ]; then
    jq -r "[.Datapoints[].Average] | if length == 0 then 0 else (add / length) end" <<<"$raw"
  else
    jq -r --arg stat "$statistic" '[.Datapoints[][$stat]] | if length == 0 then 0 else max end' <<<"$raw"
  fi
}

ecs_cpu_max="$(cw_metric "AWS/ECS" "CPUUtilization" "Maximum" 60 "$START_TIME" "$END_TIME" "Name=ClusterName,Value=$ECS_CLUSTER_NAME" "Name=ServiceName,Value=$ECS_SERVICE_NAME")"
ecs_mem_max="$(cw_metric "AWS/ECS" "MemoryUtilization" "Maximum" 60 "$START_TIME" "$END_TIME" "Name=ClusterName,Value=$ECS_CLUSTER_NAME" "Name=ServiceName,Value=$ECS_SERVICE_NAME")"
alb_requests_sum="$(cw_metric "AWS/ApplicationELB" "RequestCount" "Sum" 60 "$START_TIME" "$END_TIME" "Name=LoadBalancer,Value=$ALB_ARN_SUFFIX")"
alb_latency_max="$(cw_metric "AWS/ApplicationELB" "TargetResponseTime" "Maximum" 60 "$START_TIME" "$END_TIME" "Name=LoadBalancer,Value=$ALB_ARN_SUFFIX")"
alb_elb_5xx_sum="$(cw_metric "AWS/ApplicationELB" "HTTPCode_ELB_5XX_Count" "Sum" 60 "$START_TIME" "$END_TIME" "Name=LoadBalancer,Value=$ALB_ARN_SUFFIX")"
alb_target_5xx_sum="$(cw_metric "AWS/ApplicationELB" "HTTPCode_Target_5XX_Count" "Sum" 60 "$START_TIME" "$END_TIME" "Name=LoadBalancer,Value=$ALB_ARN_SUFFIX" "Name=TargetGroup,Value=$TARGET_GROUP_ARN_SUFFIX")"
aurora_acu_max="$(cw_metric "AWS/RDS" "ServerlessDatabaseCapacity" "Maximum" 60 "$START_TIME" "$END_TIME" "Name=DBClusterIdentifier,Value=$AURORA_CLUSTER_IDENTIFIER")"
aurora_connections_max="$(cw_metric "AWS/RDS" "DatabaseConnections" "Maximum" 60 "$START_TIME" "$END_TIME" "Name=DBClusterIdentifier,Value=$AURORA_CLUSTER_IDENTIFIER")"
redis_cpu_max="$(cw_metric "AWS/ElastiCache" "CPUUtilization" "Maximum" 60 "$START_TIME" "$END_TIME" "Name=ReplicationGroupId,Value=$REDIS_REPLICATION_GROUP_ID")"
redis_memory_max="$(cw_metric "AWS/ElastiCache" "DatabaseMemoryUsagePercentage" "Maximum" 60 "$START_TIME" "$END_TIME" "Name=ReplicationGroupId,Value=$REDIS_REPLICATION_GROUP_ID")"

timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

jq -nc \
  --arg timestamp "$timestamp" \
  --arg label "$LABEL" \
  --arg start_time "$START_TIME" \
  --arg end_time "$END_TIME" \
  --arg aws_region "$AWS_REGION" \
  --arg ecs_cluster_name "$ECS_CLUSTER_NAME" \
  --arg ecs_service_name "$ECS_SERVICE_NAME" \
  --argjson ecs_cpu_max "$ecs_cpu_max" \
  --argjson ecs_mem_max "$ecs_mem_max" \
  --argjson alb_requests_sum "$alb_requests_sum" \
  --argjson alb_latency_max "$alb_latency_max" \
  --argjson alb_elb_5xx_sum "$alb_elb_5xx_sum" \
  --argjson alb_target_5xx_sum "$alb_target_5xx_sum" \
  --argjson aurora_acu_max "$aurora_acu_max" \
  --argjson aurora_connections_max "$aurora_connections_max" \
  --argjson redis_cpu_max "$redis_cpu_max" \
  --argjson redis_memory_max "$redis_memory_max" \
  '{
    timestamp: $timestamp,
    label: $label,
    start_time: $start_time,
    end_time: $end_time,
    aws_region: $aws_region,
    ecs_cluster_name: $ecs_cluster_name,
    ecs_service_name: $ecs_service_name,
    ecs_cpu_max: $ecs_cpu_max,
    ecs_mem_max: $ecs_mem_max,
    alb_requests_sum: $alb_requests_sum,
    alb_latency_max: $alb_latency_max,
    alb_elb_5xx_sum: $alb_elb_5xx_sum,
    alb_target_5xx_sum: $alb_target_5xx_sum,
    aurora_acu_max: $aurora_acu_max,
    aurora_connections_max: $aurora_connections_max,
    redis_cpu_max: $redis_cpu_max,
    redis_memory_max: $redis_memory_max
  }' >>"$SNAPSHOT_FILE"

printf "infra cpu_max=%.1f%% mem_max=%.1f%% acu_max=%.2f redis_cpu_max=%.1f%% redis_mem_max=%.1f%% alb_5xx=%s/%s\n" \
  "$ecs_cpu_max" "$ecs_mem_max" "$aurora_acu_max" "$redis_cpu_max" "$redis_memory_max" "$alb_elb_5xx_sum" "$alb_target_5xx_sum"
