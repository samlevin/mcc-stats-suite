output "layer_bucket_names" {
  value = { for name, bucket in aws_s3_bucket.layer : name => bucket.id }
}

output "catalog_database_name" {
  value = aws_glue_catalog_database.lakehouse.name
}

output "athena_workgroup_name" {
  value = aws_athena_workgroup.analytics.name
}

output "lakehouse_key_arn" {
  value = aws_kms_key.lakehouse.arn
}
