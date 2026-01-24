output "bucket_name" {
  description = "Name of the CORS origins S3 bucket"
  value       = aws_s3_bucket.cors_origins.id
}

output "bucket_arn" {
  description = "ARN of the CORS origins S3 bucket"
  value       = aws_s3_bucket.cors_origins.arn
}

output "origins_key" {
  description = "S3 key for the origins JSON file"
  value       = var.origins_key
}

output "write_policy_arn" {
  description = "ARN of the IAM policy for writing to the bucket"
  value       = aws_iam_policy.cors_origins_write.arn
}
