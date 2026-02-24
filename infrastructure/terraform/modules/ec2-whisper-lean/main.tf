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
  name = "chalk-${var.environment}-whisper"

  tags = merge(var.tags, {
    Environment = var.environment
    Module      = "ec2-whisper-lean"
    Name        = local.name
    Project     = "chalk"
  })
}

data "aws_ssm_parameter" "al2023_x86_64_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64"
}

resource "aws_security_group" "whisper" {
  name_prefix = "${local.name}-"
  description = "Lean whisper worker ingress"

  dynamic "ingress" {
    for_each = var.ssh_ingress_cidrs
    content {
      description = "SSH"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

resource "aws_iam_role" "instance" {
  name = "${local.name}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "runtime" {
  name = "${local.name}-runtime"
  role = aws_iam_role.instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ECRToken"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "ECRPull"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer"
        ]
        Resource = var.ecr_repository_arn
      },
      {
        Sid    = "SSMReadPath"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath"
        ]
        Resource = "arn:aws:ssm:${var.aws_region}:*:parameter${var.ssm_parameter_path}*"
      },
      {
        Sid      = "KMSDecrypt"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
      },
      {
        Sid      = "PutWhisperMetrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "${local.name}-profile"
  role = aws_iam_role.instance.name
}

resource "aws_instance" "whisper" {
  ami                  = data.aws_ssm_parameter.al2023_x86_64_ami.value
  instance_type        = var.instance_type
  iam_instance_profile = aws_iam_instance_profile.instance.name

  monitoring = true

  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.whisper.id]

  dynamic "instance_market_options" {
    for_each = var.use_spot ? [1] : []
    content {
      market_type = "spot"
      spot_options {
        # Keep a standing request so interrupted workers are relaunched automatically.
        spot_instance_type             = var.spot_instance_type
        instance_interruption_behavior = var.spot_instance_interruption_behavior
      }
    }
  }

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    aws_region         = var.aws_region
    container_image    = var.container_image
    ssm_parameter_path = var.ssm_parameter_path
    app_env_static     = var.app_env_static
  })

  user_data_replace_on_change = true

  root_block_device {
    volume_size = 40
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "status_check" {
  alarm_name          = "${local.name}-status-check"
  alarm_description   = "Lean whisper worker instance status check failed"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed_Instance"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alert_actions

  dimensions = {
    InstanceId = aws_instance.whisper.id
  }

  tags = local.tags
}
