# Whisper Transcription Worker Module
# Self-hosted faster-whisper on GPU instance for transcription

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
  name = "chalk-whisper-${var.environment}"

  tags = merge(var.tags, {
    Environment = var.environment
    Module      = "whisper"
  })
}

data "aws_region" "current" {}

# -----------------------------------------------------------------------------
# AMI - Amazon Linux 2 with NVIDIA drivers
# -----------------------------------------------------------------------------

data "aws_ami" "gpu" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["amzn2-ami-ecs-gpu-hvm-*-x86_64-ebs"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# -----------------------------------------------------------------------------
# Security Group
# -----------------------------------------------------------------------------

resource "aws_security_group" "whisper" {
  name        = "${local.name}-sg"
  description = "Security group for Whisper transcription worker"
  vpc_id      = var.vpc_id

  # No ingress - worker only polls Redis and makes outbound requests
  # SSH access only from bastion if needed
  dynamic "ingress" {
    for_each = var.bastion_security_group_id != "" ? [1] : []
    content {
      description     = "SSH from bastion"
      from_port       = 22
      to_port         = 22
      protocol        = "tcp"
      security_groups = [var.bastion_security_group_id]
    }
  }

  # Egress: Redis, HTTPS (for R2/S3), and CloudWatch
  egress {
    description = "Redis"
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description = "HTTPS (R2, CloudWatch, Secrets Manager)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "HTTP (package downloads)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "DNS (UDP)"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description = "DNS (TCP)"
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = merge(local.tags, {
    Name = "${local.name}-sg"
  })
}

# -----------------------------------------------------------------------------
# IAM Role
# -----------------------------------------------------------------------------

resource "aws_iam_role" "whisper" {
  name = "${local.name}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "whisper_secrets" {
  name = "${local.name}-secrets"
  role = aws_iam_role.whisper.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          "arn:aws:secretsmanager:${data.aws_region.current.name}:*:secret:chalk/whisper/*",
          var.redis_auth_secret_arn,
          var.axiom_secret_arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        Resource = [
          var.secrets_kms_key_arn
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy" "whisper_logs" {
  name = "${local.name}-logs"
  role = aws_iam_role.whisper.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${data.aws_region.current.name}:*:log-group:/aws/ec2/${local.name}:*"
      }
    ]
  })
}

resource "aws_iam_role_policy" "whisper_metrics" {
  name = "${local.name}-metrics"
  role = aws_iam_role.whisper.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricData"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "cloudwatch:namespace" = "Chalk/Whisper"
          }
        }
      }
    ]
  })
}

# SSM for remote management
resource "aws_iam_role_policy_attachment" "whisper_ssm" {
  role       = aws_iam_role.whisper.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# ECR read access for pulling container images
resource "aws_iam_role_policy_attachment" "whisper_ecr" {
  role       = aws_iam_role.whisper.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_instance_profile" "whisper" {
  name = "${local.name}-profile"
  role = aws_iam_role.whisper.name

  tags = local.tags
}

# -----------------------------------------------------------------------------
# CloudWatch Log Group
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "whisper" {
  name              = "/aws/ec2/${local.name}"
  retention_in_days = var.log_retention_days

  tags = local.tags
}

# -----------------------------------------------------------------------------
# Launch Template
# -----------------------------------------------------------------------------

resource "aws_launch_template" "whisper" {
  name_prefix   = "${local.name}-"
  image_id      = data.aws_ami.gpu.id
  instance_type = var.instance_type

  dynamic "instance_market_options" {
    for_each = var.use_spot ? [1] : []
    content {
      market_type = "spot"
      spot_options {
        instance_interruption_behavior = var.spot_instance_interruption_behavior
        spot_instance_type             = "one-time"
      }
    }
  }

  iam_instance_profile {
    name = aws_iam_instance_profile.whisper.name
  }

  network_interfaces {
    associate_public_ip_address = false
    security_groups             = [aws_security_group.whisper.id]
  }

  user_data = base64encode(<<-EOF
    #!/bin/bash
    set -e

    # Install AWS CLI v2 (not installed by default on this AMI)
    yum install -y unzip
    curl -sL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
    cd /tmp && unzip -q awscliv2.zip && ./aws/install
    ln -sf /usr/local/bin/aws /usr/bin/aws

    # Install Docker
    amazon-linux-extras install docker -y
    systemctl enable docker
    systemctl start docker

    # Install NVIDIA Container Toolkit
    distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
    curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.repo | \
      tee /etc/yum.repos.d/nvidia-container-toolkit.repo
    yum install -y nvidia-container-toolkit
    nvidia-ctk runtime configure --runtime=docker
    systemctl restart docker

    # Install CloudWatch agent
    yum install -y amazon-cloudwatch-agent jq
    cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'CWCONFIG'
    {
      "logs": {
        "logs_collected": {
          "files": {
            "collect_list": [
              {
                "file_path": "/var/log/whisper-worker.log",
                "log_group_name": "/aws/ec2/${local.name}",
                "log_stream_name": "{instance_id}/whisper-worker"
              }
            ]
          }
        }
      }
    }
    CWCONFIG
    /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

    # Fetch Redis auth token from Secrets Manager
    REDIS_AUTH=$(aws secretsmanager get-secret-value \
      --secret-id "${var.redis_auth_secret_arn}" \
      --query SecretString --output text)

    REDIS_URL="rediss://:$REDIS_AUTH@${var.redis_endpoint}:${var.redis_port}"

    # Fetch Axiom token from Secrets Manager (dataset is non-secret, configured via Terraform)
    AXIOM_JSON=$(aws secretsmanager get-secret-value \
      --secret-id "${var.axiom_secret_arn}" \
      --query SecretString --output text)
	    AXIOM_TOKEN=$(echo "$AXIOM_JSON" | jq -r '.token // empty')

	    AXIOM_DATASET="${var.axiom_dataset_whisper}"
	    AXIOM_DOMAIN="api.axiom.co"
	    AXIOM_TRACES_DATASET="chalk-prod-traces"
	    ENVIRONMENT="${var.environment}"
	    AWS_REGION="${data.aws_region.current.name}"
	    LOG_LEVEL="${var.log_level}"
	    WHISPER_LOG_TRANSCRIPT="false"
	    WHISPER_LOG_TRANSCRIPT_MAX_CHARS="0"

	    export REDIS_URL AXIOM_TOKEN AXIOM_DATASET ENVIRONMENT AWS_REGION LOG_LEVEL \
	      AXIOM_DOMAIN AXIOM_TRACES_DATASET WHISPER_LOG_TRANSCRIPT WHISPER_LOG_TRANSCRIPT_MAX_CHARS

    # Authenticate with ECR
    ECR_REGISTRY=$(echo "${var.ecr_repository_url}" | cut -d'/' -f1)
    aws ecr get-login-password --region ${data.aws_region.current.name} | \
      docker login --username AWS --password-stdin $ECR_REGISTRY

    # Pull and run whisper worker
    docker pull ${var.ecr_repository_url}:${var.worker_image_tag}

    docker run -d \
      --name whisper-worker \
      --restart always \
      --gpus all \
      -e REDIS_URL \
      -e AWS_REGION \
      -e LOG_LEVEL \
	      -e AXIOM_TOKEN \
	      -e AXIOM_DATASET \
	      -e AXIOM_DOMAIN \
	      -e AXIOM_TRACES_DATASET \
	      -e ENVIRONMENT \
	      -e WHISPER_LOG_TRANSCRIPT \
	      -e WHISPER_LOG_TRANSCRIPT_MAX_CHARS \
      -v /var/log:/var/log \
      ${var.ecr_repository_url}:${var.worker_image_tag}
  EOF
  )

  monitoring {
    enabled = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  tag_specifications {
    resource_type = "instance"
    tags = merge(local.tags, {
      Name = "${local.name}-instance"
    })
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

# -----------------------------------------------------------------------------
# Auto Scaling Group
# -----------------------------------------------------------------------------

resource "aws_autoscaling_group" "whisper" {
  name_prefix         = "${local.name}-"
  vpc_zone_identifier = var.subnet_ids
  min_size            = var.min_capacity
  max_size            = var.max_capacity
  desired_capacity    = var.desired_capacity
  capacity_rebalance  = var.use_spot

  launch_template {
    id      = aws_launch_template.whisper.id
    version = "$Latest"
  }

  health_check_type         = "EC2"
  health_check_grace_period = 300

  tag {
    key                 = "Name"
    value               = "${local.name}-instance"
    propagate_at_launch = true
  }

  tag {
    key                 = "Environment"
    value               = var.environment
    propagate_at_launch = true
  }

  lifecycle {
    create_before_destroy = true
    ignore_changes        = [desired_capacity]
  }
}

# -----------------------------------------------------------------------------
# Auto Scaling Policies
# -----------------------------------------------------------------------------

# Scale based on Redis queue depth (CloudWatch custom metric from worker)
resource "aws_autoscaling_policy" "scale_up" {
  count = var.enable_autoscaling ? 1 : 0

  name                   = "${local.name}-scale-up"
  autoscaling_group_name = aws_autoscaling_group.whisper.name
  adjustment_type        = "ChangeInCapacity"
  scaling_adjustment     = 1
  cooldown               = 300
}

resource "aws_autoscaling_policy" "scale_down" {
  count = var.enable_autoscaling ? 1 : 0

  name                   = "${local.name}-scale-down"
  autoscaling_group_name = aws_autoscaling_group.whisper.name
  adjustment_type        = "ChangeInCapacity"
  scaling_adjustment     = -1
  cooldown               = 600
}

resource "aws_cloudwatch_metric_alarm" "queue_depth_high" {
  count = var.enable_autoscaling ? 1 : 0

  alarm_name          = "${local.name}-queue-depth-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "TranscriptionQueueDepth"
  namespace           = "Chalk/Whisper"
  period              = 60
  statistic           = "Average"
  threshold           = var.scale_up_threshold
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_autoscaling_policy.scale_up[0].arn]

  dimensions = {
    Environment = var.environment
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "queue_depth_low" {
  count = var.enable_autoscaling ? 1 : 0

  alarm_name          = "${local.name}-queue-depth-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 5
  metric_name         = "TranscriptionQueueDepth"
  namespace           = "Chalk/Whisper"
  period              = 60
  statistic           = "Average"
  threshold           = var.scale_down_threshold
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_autoscaling_policy.scale_down[0].arn]

  dimensions = {
    Environment = var.environment
  }

  tags = local.tags
}
