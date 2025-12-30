resource "aws_ecs_task_definition" "api" {
  count = var.create_service ? 1 : 0

  family                   = "${local.name}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["EC2"]
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name  = "api"
      image = var.container_image

      portMappings = [
        {
          containerPort = local.container_port
          hostPort      = local.container_port
          protocol      = "tcp"
        }
      ]

      environment = concat([
        {
          name  = "ENVIRONMENT"
          value = var.environment
        },
        {
          name  = "ENV"
          value = var.environment == "prod" ? "production" : var.environment
        },
        {
          name  = "PORT"
          value = tostring(local.container_port)
        }
      ], var.container_environment)

      secrets = var.container_secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "api"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:${local.container_port}/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }

      essential = true
    }
  ])

  tags = local.tags
}

resource "aws_ecs_service" "api" {
  count = var.create_service ? 1 : 0

  name            = "${local.name}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api[0].arn
  desired_count   = var.service_desired_count

  capacity_provider_strategy {
    base              = 1
    weight            = 100
    capacity_provider = aws_ecs_capacity_provider.main.name
  }

  network_configuration {
    subnets         = var.private_subnet_ids
    security_groups = [aws_security_group.ecs_tasks[0].id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.main.arn
    container_name   = "api"
    container_port   = local.container_port
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 50

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  enable_execute_command = var.enable_execute_command

  lifecycle {
    ignore_changes = [desired_count]
  }

  tags = local.tags

  depends_on = [aws_lb_listener.http]
}

resource "aws_security_group" "ecs_tasks" {
  count = var.create_service ? 1 : 0

  name        = "${local.name}-ecs-tasks-sg"
  description = "Security group for ECS tasks"
  vpc_id      = var.vpc_id

  ingress {
    description     = "From ALB"
    from_port       = local.container_port
    to_port         = local.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, {
    Name = "${local.name}-ecs-tasks-sg"
  })
}

resource "aws_appautoscaling_target" "ecs" {
  count = var.create_service && var.enable_autoscaling ? 1 : 0

  max_capacity       = var.service_max_count
  min_capacity       = var.service_min_count
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "ecs_cpu" {
  count = var.create_service && var.enable_autoscaling ? 1 : 0

  name               = "${local.name}-cpu-autoscaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 70
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_policy" "ecs_memory" {
  count = var.create_service && var.enable_autoscaling ? 1 : 0

  name               = "${local.name}-memory-autoscaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
    target_value       = 80
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}
