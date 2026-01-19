terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket = "chalk-terraform-state"
    key    = "stress-test/terraform.tfstate"
    region = "us-east-1"
  }
}

provider "aws" {
  region = var.aws_region
}

locals {
  name_prefix = "chalk-stress"
  tags = {
    Environment = "stress-test"
    Project     = "chalk"
    ManagedBy   = "terraform"
  }
}

# Use existing VPC from main infrastructure
data "aws_vpc" "main" {
  tags = {
    Name = "chalk-prod"
  }
}

data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.main.id]
  }
  tags = {
    Tier = "private"
  }
}

data "aws_ami" "amazon_linux" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["amzn2-ami-hvm-*-x86_64-gp2"]
  }
}

# Separate ECS cluster for stress testing
resource "aws_ecs_cluster" "stress" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = local.tags
}

resource "aws_ecs_cluster_capacity_providers" "stress" {
  cluster_name = aws_ecs_cluster.stress.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }
}

# IAM roles for ECS
resource "aws_iam_role" "ecs_execution" {
  name = "${local.name_prefix}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "ecs_task" {
  name = "${local.name_prefix}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })

  tags = local.tags
}

# CloudWatch log group
resource "aws_cloudwatch_log_group" "api" {
  name              = "/chalk-stress/api"
  retention_in_days = 7

  tags = local.tags
}

# Security groups
resource "aws_security_group" "api" {
  name        = "${local.name_prefix}-api"
  description = "Security group for stress test API"
  vpc_id      = data.aws_vpc.main.id

  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb"
  description = "Security group for stress test ALB"
  vpc_id      = data.aws_vpc.main.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

resource "aws_security_group" "db" {
  name        = "${local.name_prefix}-db"
  description = "Security group for stress test Aurora"
  vpc_id      = data.aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id]
  }

  tags = local.tags
}

resource "aws_security_group" "redis" {
  name        = "${local.name_prefix}-redis"
  description = "Security group for stress test Redis"
  vpc_id      = data.aws_vpc.main.id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id]
  }

  tags = local.tags
}

resource "aws_security_group" "load_generator" {
  name        = "${local.name_prefix}-load-gen"
  description = "Security group for load generators"
  vpc_id      = data.aws_vpc.main.id

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }

  ingress {
    from_port   = 9090
    to_port     = 9090
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

# ALB
resource "aws_lb" "stress" {
  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.private.ids

  tags = local.tags
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name_prefix}-api"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.main.id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 30
    matcher             = "200"
    path                = "/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    timeout             = 5
    unhealthy_threshold = 3
  }

  tags = local.tags
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.stress.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# ECS Task Definition
resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = var.api_image
      essential = true

      portMappings = [
        {
          containerPort = 8080
          hostPort      = 8080
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "ENVIRONMENT", value = "stress-test" },
        { name = "DB_MAX_CONNS", value = "50" },
        { name = "REDIS_POOL_SIZE", value = "20" },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "api"
        }
      }
    }
  ])

  tags = local.tags
}

# ECS Service
resource "aws_ecs_service" "api" {
  name            = "${local.name_prefix}-api"
  cluster         = aws_ecs_cluster.stress.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 3

  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }

  network_configuration {
    subnets         = data.aws_subnets.private.ids
    security_groups = [aws_security_group.api.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8080
  }

  tags = local.tags
}

# Aurora Serverless v2
resource "aws_db_subnet_group" "stress" {
  name       = "${local.name_prefix}-db"
  subnet_ids = data.aws_subnets.private.ids

  tags = local.tags
}

resource "aws_rds_cluster" "stress" {
  cluster_identifier     = "${local.name_prefix}-db"
  engine                 = "aurora-postgresql"
  engine_mode            = "provisioned"
  engine_version         = "16.4"
  database_name          = "chalk_stress"
  master_username        = var.db_username
  master_password        = var.db_password
  skip_final_snapshot    = true
  deletion_protection    = false

  serverlessv2_scaling_configuration {
    min_capacity = 1.0
    max_capacity = 4.0
  }

  vpc_security_group_ids = [aws_security_group.db.id]
  db_subnet_group_name   = aws_db_subnet_group.stress.name

  tags = local.tags
}

resource "aws_rds_cluster_instance" "stress" {
  count              = 2
  identifier         = "${local.name_prefix}-db-${count.index}"
  cluster_identifier = aws_rds_cluster.stress.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.stress.engine
  engine_version     = aws_rds_cluster.stress.engine_version

  tags = local.tags
}

# ElastiCache Redis
resource "aws_elasticache_subnet_group" "stress" {
  name       = "${local.name_prefix}-redis"
  subnet_ids = data.aws_subnets.private.ids

  tags = local.tags
}

resource "aws_elasticache_replication_group" "stress" {
  replication_group_id       = "${local.name_prefix}-redis"
  description                = "Stress test Redis cluster"
  node_type                  = "cache.t3.small"
  num_cache_clusters         = 2
  port                       = 6379
  automatic_failover_enabled = true
  multi_az_enabled           = true

  subnet_group_name  = aws_elasticache_subnet_group.stress.name
  security_group_ids = [aws_security_group.redis.id]

  tags = local.tags
}

# Load generator instances
resource "aws_instance" "load_generator" {
  count         = 3
  ami           = data.aws_ami.amazon_linux.id
  instance_type = "c5.xlarge"
  subnet_id     = element(data.aws_subnets.private.ids, count.index)

  vpc_security_group_ids = [aws_security_group.load_generator.id]

  user_data = <<-EOF
    #!/bin/bash
    # Install k6
    sudo yum update -y
    sudo yum install -y amazon-linux-extras
    sudo amazon-linux-extras install epel -y

    # Install k6 from Grafana repo
    sudo cat <<REPO | sudo tee /etc/yum.repos.d/bintray-loadimpact-rpm.repo
[k6-rpm]
name=k6-rpm
baseurl=https://dl.k6.io/rpm/\$basearch/
enabled=1
gpgcheck=0
REPO
    sudo yum install -y k6

    # Install Node.js and Artillery
    curl -sL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo yum install -y nodejs
    sudo npm install -g artillery

    # Install Go for WebRTC client
    wget https://go.dev/dl/go1.22.0.linux-amd64.tar.gz
    sudo tar -C /usr/local -xzf go1.22.0.linux-amd64.tar.gz
    echo 'export PATH=$PATH:/usr/local/go/bin' >> /home/ec2-user/.bashrc
  EOF

  tags = merge(local.tags, {
    Name = "${local.name_prefix}-load-gen-${count.index}"
  })
}

# CloudWatch dashboard
resource "aws_cloudwatch_dashboard" "stress" {
  dashboard_name = "${local.name_prefix}-dashboard"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "ECS CPU & Memory"
          region = var.aws_region
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.stress.name],
            [".", "MemoryUtilization", ".", "."],
          ]
          period = 60
          stat   = "Average"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Aurora Connections & ACU"
          region = var.aws_region
          metrics = [
            ["AWS/RDS", "DatabaseConnections", "DBClusterIdentifier", aws_rds_cluster.stress.cluster_identifier],
            [".", "ServerlessDatabaseCapacity", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Redis CPU & Memory"
          region = var.aws_region
          metrics = [
            ["AWS/ElastiCache", "CPUUtilization", "ReplicationGroupId", aws_elasticache_replication_group.stress.id],
            [".", "DatabaseMemoryUsagePercentage", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "ALB Request Count & Latency"
          region = var.aws_region
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.stress.arn_suffix],
            [".", "TargetResponseTime", ".", ".", { stat = "p95" }],
          ]
        }
      }
    ]
  })
}
