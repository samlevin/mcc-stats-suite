output "raw_email_bucket_name" {
  value = aws_s3_bucket.raw_email.id
}

output "attachments_bucket_name" {
  value = aws_s3_bucket.attachments.id
}

output "output_bucket_name" {
  value = aws_s3_bucket.output.id
}

output "data_key_arn" {
  value = aws_kms_key.data.arn
}
