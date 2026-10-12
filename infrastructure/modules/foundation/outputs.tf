output "raw_email_bucket_name" {
  value = aws_s3_bucket.raw_email.id
}

output "attachments_bucket_name" {
  value = aws_s3_bucket.attachments.id
}

output "output_bucket_name" {
  value = aws_s3_bucket.output.id
}

output "evidence_bucket_name" {
  value = aws_s3_bucket.evidence.id
}

output "data_key_arn" {
  value = aws_kms_key.data.arn
}

output "turbo_cache_bucket_name" {
  value = aws_s3_bucket.turbo_cache.id
}

output "turbo_cache_key_arn" {
  value = aws_kms_key.data.arn
}

output "turbo_cache_service_policy_json" {
  description = "Object read/write and bucket-scoped S3 KMS permissions for a future cache service role. Does not create or grant access to any role."
  value       = data.aws_iam_policy_document.turbo_cache_service.json
}

output "github_turbo_cache_role_arn" {
  description = "Dedicated cache workload role; never the CDK deployment role."
  value       = var.create_github_cache_role ? local.cache_role_arn : null
}

output "receipt_rule_set_name" {
  value = aws_ses_receipt_rule_set.inbound.rule_set_name
}
