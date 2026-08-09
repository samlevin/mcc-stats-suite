data "aws_caller_identity" "current" {}

locals {
  name = "${var.project_name}-${var.environment}"
  layers = toset([
    "bronze",
    "silver",
    "gold",
  ])
}

resource "aws_kms_key" "lakehouse" {
  description             = "${local.name} lakehouse data"
  deletion_window_in_days = var.environment == "prod" ? 30 : 7
  enable_key_rotation     = true
}

resource "aws_kms_alias" "lakehouse" {
  name          = "alias/${local.name}-lakehouse"
  target_key_id = aws_kms_key.lakehouse.key_id
}

resource "aws_s3_bucket" "layer" {
  for_each      = local.layers
  bucket        = "${local.name}-${data.aws_caller_identity.current.account_id}-${each.key}"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "layer" {
  for_each = aws_s3_bucket.layer
  bucket   = each.value.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "layer" {
  for_each = aws_s3_bucket.layer
  bucket   = each.value.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "layer" {
  for_each = aws_s3_bucket.layer
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.lakehouse.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_glue_catalog_database" "lakehouse" {
  name        = replace("${local.name}-lakehouse", "-", "_")
  description = "${local.name} medallion lakehouse catalog"
}

resource "aws_athena_workgroup" "analytics" {
  name = "${local.name}-analytics"
  configuration {
    enforce_workgroup_configuration = true
    result_configuration {
      output_location = "s3://${aws_s3_bucket.layer["gold"].id}/athena-results/"
      encryption_configuration {
        encryption_option = "SSE_KMS"
        kms_key_arn       = aws_kms_key.lakehouse.arn
      }
    }
  }
}

resource "aws_ssm_parameter" "layer_bucket_name" {
  for_each = aws_s3_bucket.layer
  name     = "/mcc/${var.environment}/data-platform/${each.key}-bucket-name"
  type     = "String"
  value    = each.value.id
}

resource "aws_ssm_parameter" "catalog_database_name" {
  name  = "/mcc/${var.environment}/data-platform/catalog-database-name"
  type  = "String"
  value = aws_glue_catalog_database.lakehouse.name
}

resource "aws_ssm_parameter" "lakehouse_key_arn" {
  name  = "/mcc/${var.environment}/data-platform/kms-key-arn"
  type  = "String"
  value = aws_kms_key.lakehouse.arn
}
