terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
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

resource "random_password" "redis_auth" {
  count = var.redis_auth_token == "" ? 1 : 0

  length  = 32
  special = false
}

locals {
  api_image_resolved = var.api_image != "" ? var.api_image : "${aws_ecr_repository.api.repository_url}:latest"
  redis_auth_token   = var.redis_auth_token != "" ? var.redis_auth_token : random_password.redis_auth[0].result
}

resource "aws_ecr_repository" "api" {
  name                 = "${local.name_prefix}-api"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

 

# Dedicated VPC for stress testing
resource "aws_vpc" "stress" {
  cidr_block           = "10.50.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "${local.name_prefix}-vpc" })
}

resource "aws_internet_gateway" "stress" {
  vpc_id = aws_vpc.stress.id
  tags   = local.tags
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.stress.id
  cidr_block              = "10.50.0.0/20"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true
  tags                    = merge(local.tags, { Tier = "public" })
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.stress.id
  cidr_block              = "10.50.16.0/20"
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = true
  tags                    = merge(local.tags, { Tier = "public" })
}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.stress.id
  cidr_block        = "10.50.32.0/20"
  availability_zone = "${var.aws_region}a"
  tags              = merge(local.tags, { Tier = "private" })
}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.stress.id
  cidr_block        = "10.50.48.0/20"
  availability_zone = "${var.aws_region}b"
  tags              = merge(local.tags, { Tier = "private" })
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = local.tags
}

resource "aws_nat_gateway" "stress" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public_a.id
  tags          = local.tags
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.stress.id
  tags   = merge(local.tags, { Tier = "public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.stress.id
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.stress.id
  tags   = merge(local.tags, { Tier = "private" })
}

resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.stress.id
}

resource "aws_route_table_association" "private_a" {
  subnet_id      = aws_subnet.private_a.id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "private_b" {
  subnet_id      = aws_subnet.private_b.id
  route_table_id = aws_route_table.private.id
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

  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
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
  vpc_id      = aws_vpc.stress.id

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
  vpc_id      = aws_vpc.stress.id

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
  vpc_id      = aws_vpc.stress.id

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
  vpc_id      = aws_vpc.stress.id

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
  vpc_id      = aws_vpc.stress.id

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
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]

  tags = local.tags
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name_prefix}-api"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = aws_vpc.stress.id
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
  cpu                      = var.ecs_task_cpu
  memory                   = var.ecs_task_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = local.api_image_resolved
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
        { name = "DATABASE_HOST", value = aws_rds_cluster.stress.endpoint },
        { name = "DATABASE_PORT", value = "5432" },
        { name = "DATABASE_NAME", value = "chalk_stress" },
        { name = "DATABASE_USER", value = var.db_username },
        { name = "DATABASE_PASSWORD", value = var.db_password },
        { name = "DATABASE_SSLMODE", value = "require" },
        { name = "REDIS_HOST", value = aws_elasticache_replication_group.stress.primary_endpoint_address },
        { name = "REDIS_PORT", value = "6379" },
        { name = "REDIS_TLS", value = "true" },
        { name = "REDIS_PASSWORD", value = local.redis_auth_token },
        { name = "API_PUBLIC_URL", value = "http://${aws_lb.stress.dns_name}" },
        { name = "CLOUDFLARE_ACCOUNT_ID", value = var.cloudflare_account_id },
        { name = "CLOUDFLARE_APP_ID", value = var.cloudflare_app_id },
        { name = "CLOUDFLARE_API_TOKEN", value = var.cloudflare_api_token },
        { name = "CLOUDFLARE_MOCK", value = var.cloudflare_mock ? "true" : "false" },
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
  desired_count   = var.ecs_desired_count

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  network_configuration {
    subnets         = [aws_subnet.private_a.id, aws_subnet.private_b.id]
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
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]

  tags = local.tags
}

resource "aws_rds_cluster" "stress" {
  cluster_identifier     = "${local.name_prefix}-db"
  engine                 = "aurora-postgresql"
  engine_version         = "16.4"
  database_name          = "chalk_stress"
  master_username        = var.db_username
  master_password        = var.db_password
  skip_final_snapshot    = true
  deletion_protection    = false

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_capacity
    max_capacity = var.aurora_max_capacity
  }

  vpc_security_group_ids = [aws_security_group.db.id]
  db_subnet_group_name   = aws_db_subnet_group.stress.name

  tags = local.tags
}

resource "aws_rds_cluster_instance" "stress" {
  count              = var.db_instance_count
  identifier         = "${local.name_prefix}-db-${count.index}"
  cluster_identifier = aws_rds_cluster.stress.id
  instance_class     = var.db_instance_class
  engine             = aws_rds_cluster.stress.engine
  engine_version     = aws_rds_cluster.stress.engine_version

  tags = local.tags
}

# ElastiCache Redis
resource "aws_elasticache_subnet_group" "stress" {
  name       = "${local.name_prefix}-redis"
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]

  tags = local.tags
}

resource "aws_elasticache_replication_group" "stress" {
  replication_group_id       = "${local.name_prefix}-redis"
  description                = "Stress test Redis cluster"
  node_type                  = var.redis_node_type
  num_cache_clusters         = var.redis_num_cache_clusters
  port                       = 6379
  automatic_failover_enabled = true
  multi_az_enabled           = true

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = local.redis_auth_token

  subnet_group_name  = aws_elasticache_subnet_group.stress.name
  security_group_ids = [aws_security_group.redis.id]

  tags = local.tags
}

# Load generator instances
resource "aws_instance" "load_generator" {
  count         = var.load_generator_count
  ami           = data.aws_ami.amazon_linux.id
  instance_type = var.load_generator_instance_type
  subnet_id     = element([aws_subnet.private_a.id, aws_subnet.private_b.id], count.index)

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
