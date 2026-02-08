terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
}

locals {
  name = "chalk-${var.environment}"

  tags = merge(var.tags, {
    Environment = var.environment
    Module      = "monitoring"
  })
}

resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"

  tags = local.tags
}

resource "aws_sns_topic_subscription" "email" {
  count = length(var.alert_emails)

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_emails[count.index]
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu_high" {
  count = var.ecs_cluster_name != null && var.ecs_cluster_name != "" && var.enable_ecs_alarms ? 1 : 0

  alarm_name          = "${local.name}-ecs-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "ECS CPU utilization exceeds 80%"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = var.ecs_service_name
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_memory_high" {
  count = var.ecs_cluster_name != null && var.ecs_cluster_name != "" && var.enable_ecs_alarms ? 1 : 0

  alarm_name          = "${local.name}-ecs-memory-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 85
  alarm_description   = "ECS memory utilization exceeds 85%"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = var.ecs_service_name
  }

  tags = local.tags
}

resource "aws_cloudwatch_log_metric_filter" "websocket_send_drops" {
  count = var.ecs_log_group_name != null && var.ecs_log_group_name != "" && var.enable_websocket_alarms ? 1 : 0

  name           = "${local.name}-ws-send-drops-filter"
  log_group_name = var.ecs_log_group_name

  # JSON slog line emitted by ws hub metrics ticker
  pattern = "{ $.event = \"ws.metrics\" }"

  metric_transformation {
    name      = "${local.name}-ws-send-drops"
    namespace = "Chalk/WebSocket"
    value     = "$.sends_dropped"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "websocket_write_errors" {
  count = var.ecs_log_group_name != null && var.ecs_log_group_name != "" && var.enable_websocket_alarms ? 1 : 0

  name           = "${local.name}-ws-write-errors-filter"
  log_group_name = var.ecs_log_group_name

  # JSON slog line emitted by ws hub metrics ticker
  pattern = "{ $.event = \"ws.metrics\" }"

  metric_transformation {
    name      = "${local.name}-ws-write-errors"
    namespace = "Chalk/WebSocket"
    value     = "$.write_errors"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "websocket_ping_errors" {
  count = var.ecs_log_group_name != null && var.ecs_log_group_name != "" && var.enable_websocket_alarms ? 1 : 0

  name           = "${local.name}-ws-ping-errors-filter"
  log_group_name = var.ecs_log_group_name

  # JSON slog line emitted by ws hub metrics ticker
  pattern = "{ $.event = \"ws.metrics\" }"

  metric_transformation {
    name      = "${local.name}-ws-ping-errors"
    namespace = "Chalk/WebSocket"
    value     = "$.ping_errors"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "websocket_clients" {
  count = var.ecs_log_group_name != null && var.ecs_log_group_name != "" && var.enable_websocket_alarms ? 1 : 0

  name           = "${local.name}-ws-clients-filter"
  log_group_name = var.ecs_log_group_name

  # JSON slog line emitted by ws hub metrics ticker
  pattern = "{ $.event = \"ws.metrics\" }"

  metric_transformation {
    name      = "${local.name}-ws-clients"
    namespace = "Chalk/WebSocket"
    value     = "$.clients"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "websocket_rooms" {
  count = var.ecs_log_group_name != null && var.ecs_log_group_name != "" && var.enable_websocket_alarms ? 1 : 0

  name           = "${local.name}-ws-rooms-filter"
  log_group_name = var.ecs_log_group_name

  # JSON slog line emitted by ws hub metrics ticker
  pattern = "{ $.event = \"ws.metrics\" }"

  metric_transformation {
    name      = "${local.name}-ws-rooms"
    namespace = "Chalk/WebSocket"
    value     = "$.rooms"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "websocket_send_drops" {
  count = var.ecs_log_group_name != null && var.ecs_log_group_name != "" && var.enable_websocket_alarms ? 1 : 0

  alarm_name          = "${local.name}-ws-send-drops-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "${local.name}-ws-send-drops"
  namespace           = "Chalk/WebSocket"
  period              = 300
  statistic           = "Sum"
  threshold           = 25
  alarm_description   = "WebSocket send drops detected (likely backpressure / stuck clients)"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "websocket_write_errors" {
  count = var.ecs_log_group_name != null && var.ecs_log_group_name != "" && var.enable_websocket_alarms ? 1 : 0

  alarm_name          = "${local.name}-ws-write-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "${local.name}-ws-write-errors"
  namespace           = "Chalk/WebSocket"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "WebSocket write errors detected (disconnects / network issues)"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "websocket_ping_errors" {
  count = var.ecs_log_group_name != null && var.ecs_log_group_name != "" && var.enable_websocket_alarms ? 1 : 0

  alarm_name          = "${local.name}-ws-ping-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "${local.name}-ws-ping-errors"
  namespace           = "Chalk/WebSocket"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "WebSocket ping errors detected (stalled connections)"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx_errors" {
  count = var.enable_alb_alarms ? 1 : 0

  alarm_name          = "${local.name}-alb-5xx-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_ELB_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = 50
  alarm_description   = "ALB 5XX errors exceed threshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "alb_latency" {
  count = var.enable_alb_alarms ? 1 : 0

  alarm_name          = "${local.name}-alb-latency-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "TargetResponseTime"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  extended_statistic  = "p99"
  threshold           = 0.5
  alarm_description   = "ALB p99 latency exceeds 500ms"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "alb_target_5xx_errors" {
  count = var.enable_alb_target_alarms && var.alb_arn_suffix != "" && var.alb_target_group_arn_suffix != "" ? 1 : 0

  alarm_name          = "${local.name}-alb-target-5xx-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "Target 5XX errors exceed threshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.alb_target_group_arn_suffix
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_hosts" {
  count = var.enable_alb_target_alarms && var.alb_arn_suffix != "" && var.alb_target_group_arn_suffix != "" ? 1 : 0

  alarm_name          = "${local.name}-alb-unhealthy-hosts"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "ALB target group has unhealthy hosts"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.alb_target_group_arn_suffix
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "alb_healthy_hosts_low" {
  count = var.enable_alb_target_alarms && var.alb_arn_suffix != "" && var.alb_target_group_arn_suffix != "" ? 1 : 0

  alarm_name          = "${local.name}-alb-healthy-hosts-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "ALB target group has no healthy hosts"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.alb_target_group_arn_suffix
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "alb_target_connection_errors" {
  count = var.enable_alb_target_alarms && var.alb_arn_suffix != "" && var.alb_target_group_arn_suffix != "" ? 1 : 0

  alarm_name          = "${local.name}-alb-target-connection-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "TargetConnectionErrorCount"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "ALB target connection errors detected"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.alb_target_group_arn_suffix
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "aurora_cpu" {
  count = var.aurora_cluster_id != null && var.aurora_cluster_id != "" && var.enable_aurora_alarms ? 1 : 0

  alarm_name          = "${local.name}-aurora-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Aurora CPU utilization exceeds 80%"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    DBClusterIdentifier = var.aurora_cluster_id
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "aurora_connections" {
  count = var.aurora_cluster_id != null && var.aurora_cluster_id != "" && var.enable_aurora_alarms ? 1 : 0

  alarm_name          = "${local.name}-aurora-connections-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = var.aurora_max_connections * 0.8
  alarm_description   = "Aurora connections exceed 80% of max"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    DBClusterIdentifier = var.aurora_cluster_id
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "aurora_acu_near_max" {
  count = var.aurora_cluster_id != null && var.aurora_cluster_id != "" && var.enable_aurora_alarms && var.aurora_max_capacity_acu != null ? 1 : 0

  alarm_name          = "${local.name}-aurora-acu-near-max"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "ServerlessDatabaseCapacity"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Maximum"
  threshold           = var.aurora_max_capacity_acu * 0.90
  alarm_description   = "Aurora Serverless v2 ACU is nearing max capacity"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBClusterIdentifier = var.aurora_cluster_id
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "aurora_acu_at_max" {
  count = var.aurora_cluster_id != null && var.aurora_cluster_id != "" && var.enable_aurora_alarms && var.aurora_max_capacity_acu != null ? 1 : 0

  alarm_name          = "${local.name}-aurora-acu-at-max"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ServerlessDatabaseCapacity"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Maximum"
  threshold           = var.aurora_max_capacity_acu * 0.99
  alarm_description   = "Aurora Serverless v2 ACU is at max capacity"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBClusterIdentifier = var.aurora_cluster_id
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "redis_cpu" {
  count = var.enable_redis_alarms && length(var.redis_cache_cluster_ids) == 0 && var.redis_replication_group_id != null && var.redis_replication_group_id != "" ? 1 : 0

  alarm_name          = "${local.name}-redis-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Average"
  threshold           = 75
  alarm_description   = "Redis CPU utilization exceeds 75%"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    CacheClusterId = var.redis_replication_group_id
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  count = var.enable_redis_alarms && length(var.redis_cache_cluster_ids) == 0 && var.redis_replication_group_id != null && var.redis_replication_group_id != "" ? 1 : 0

  alarm_name          = "${local.name}-redis-memory-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseMemoryUsagePercentage"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Redis memory usage exceeds 80%"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    CacheClusterId = var.redis_replication_group_id
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "redis_cpu_node" {
  for_each = var.enable_redis_alarms ? toset(var.redis_cache_cluster_ids) : toset([])

  alarm_name          = "${local.name}-redis-${trimprefix(each.value, "${local.name}-redis-")}-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Average"
  threshold           = 75
  alarm_description   = "Redis CPU utilization exceeds 75%"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    CacheClusterId = each.value
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "redis_memory_node" {
  for_each = var.enable_redis_alarms ? toset(var.redis_cache_cluster_ids) : toset([])

  alarm_name          = "${local.name}-redis-${trimprefix(each.value, "${local.name}-redis-")}-memory-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseMemoryUsagePercentage"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Redis memory usage exceeds 80%"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    CacheClusterId = each.value
  }

  tags = local.tags
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${local.name}-overview"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "text"
        x      = 0
        y      = 0
        width  = 24
        height = 1
        properties = {
          markdown = "# Chalk ${var.environment} - Infrastructure Dashboard"
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 1
        width  = 8
        height = 6
        properties = {
          title  = "ECS CPU/Memory"
          region = data.aws_region.current.name
          metrics = var.ecs_cluster_name != "" ? [
            ["AWS/ECS", "CPUUtilization", "ClusterName", var.ecs_cluster_name, { label = "CPU" }],
            [".", "MemoryUtilization", ".", ".", { label = "Memory" }]
          ] : []
          period = 300
          stat   = "Average"
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 1
        width  = 8
        height = 6
        properties = {
          title  = "ALB Request Count & Latency"
          region = data.aws_region.current.name
          metrics = var.alb_arn_suffix != "" ? [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix, { label = "Requests" }],
            [".", "TargetResponseTime", ".", ".", { label = "Latency", stat = "p99" }]
          ] : []
          period = 300
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 1
        width  = 8
        height = 6
        properties = {
          title  = "ALB HTTP Errors"
          region = data.aws_region.current.name
          metrics = var.alb_arn_suffix != "" ? [
            ["AWS/ApplicationELB", "HTTPCode_ELB_4XX_Count", "LoadBalancer", var.alb_arn_suffix, { label = "4XX", color = "#ff7f0e" }],
            [".", "HTTPCode_ELB_5XX_Count", ".", ".", { label = "5XX", color = "#d62728" }]
          ] : []
          period = 300
          stat   = "Sum"
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 7
        width  = 8
        height = 6
        properties = {
          title  = "ALB Target Health"
          region = data.aws_region.current.name
          metrics = var.alb_target_group_arn_suffix != "" ? [
            ["AWS/ApplicationELB", "HealthyHostCount", "LoadBalancer", var.alb_arn_suffix, "TargetGroup", var.alb_target_group_arn_suffix, { label = "Healthy", color = "#2ca02c" }],
            [".", "UnHealthyHostCount", ".", ".", ".", ".", { label = "Unhealthy", color = "#d62728" }]
          ] : []
          period = 60
          stat   = "Average"
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 7
        width  = 8
        height = 6
        properties = {
          title  = "ALB Target Errors"
          region = data.aws_region.current.name
          metrics = var.alb_target_group_arn_suffix != "" ? [
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", var.alb_arn_suffix, "TargetGroup", var.alb_target_group_arn_suffix, { label = "Target 5XX", color = "#d62728" }],
            [".", "TargetConnectionErrorCount", ".", ".", ".", ".", { label = "Conn Errors", color = "#9467bd" }]
          ] : []
          period = 300
          stat   = "Sum"
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 7
        width  = 8
        height = 6
        properties = {
          title  = "Aurora Metrics"
          region = data.aws_region.current.name
          metrics = var.aurora_cluster_id != null && var.aurora_cluster_id != "" ? [
            ["AWS/RDS", "CPUUtilization", "DBClusterIdentifier", var.aurora_cluster_id, { label = "CPU" }],
            [".", "DatabaseConnections", ".", ".", { label = "Connections", yAxis = "right" }],
            [".", "ServerlessDatabaseCapacity", ".", ".", { label = "ACU (max)", stat = "Maximum", yAxis = "right" }]
          ] : []
          period = 300
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 13
        width  = 8
        height = 6
        properties = {
          title  = "Redis Metrics"
          region = data.aws_region.current.name
          metrics = jsondecode(
            length(var.redis_cache_cluster_ids) > 0 ? jsonencode(
              concat([
                for id in var.redis_cache_cluster_ids : [
                  ["AWS/ElastiCache", "CPUUtilization", "CacheClusterId", id, { label = "${id} CPU", yAxis = "left" }],
                  [".", "DatabaseMemoryUsagePercentage", ".", ".", { label = "${id} Memory", yAxis = "right" }]
                ]
              ]...)
              ) : var.redis_replication_group_id != null && var.redis_replication_group_id != "" ? jsonencode([
                ["AWS/ElastiCache", "CPUUtilization", "CacheClusterId", var.redis_replication_group_id, { label = "CPU", yAxis = "left" }],
                [".", "DatabaseMemoryUsagePercentage", ".", ".", { label = "Memory", yAxis = "right" }]
            ]) : "[]"
          )
          period = 300
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 13
        width  = 8
        height = 6
        properties = {
          title  = "API Gateway"
          region = data.aws_region.current.name
          metrics = var.api_gateway_id != "" ? [
            ["AWS/ApiGateway", "Count", "ApiId", var.api_gateway_id, { label = "Requests" }],
            [".", "Latency", ".", ".", { label = "Latency", stat = "p99" }]
          ] : []
          period = 300
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 13
        width  = 8
        height = 6
        properties = {
          title  = "WebSocket Health"
          region = data.aws_region.current.name
          metrics = var.ecs_log_group_name != null && var.ecs_log_group_name != "" ? [
            ["Chalk/WebSocket", "${local.name}-ws-send-drops", { label = "Send drops", stat = "Sum", color = "#d62728" }],
            [".", "${local.name}-ws-write-errors", { label = "Write errors", stat = "Sum", color = "#9467bd" }],
            [".", "${local.name}-ws-ping-errors", { label = "Ping errors", stat = "Sum", color = "#ff7f0e" }],
            [".", "${local.name}-ws-clients", { label = "Clients", stat = "Average", yAxis = "right" }],
            [".", "${local.name}-ws-rooms", { label = "Rooms", stat = "Average", yAxis = "right" }]
          ] : []
          period = 60
        }
      }
    ]
  })
}

data "aws_region" "current" {}
