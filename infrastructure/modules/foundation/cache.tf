data "aws_region" "current" {}

resource "aws_s3_bucket" "turbo_cache" {
  bucket              = "${local.name}-${data.aws_caller_identity.current.account_id}-turbo-cache"
  force_destroy       = var.force_destroy
  object_lock_enabled = false
}

resource "aws_s3_bucket_public_access_block" "turbo_cache" {
  bucket = aws_s3_bucket.turbo_cache.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "turbo_cache" {
  bucket = aws_s3_bucket.turbo_cache.id
  versioning_configuration {
    status = "Disabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "turbo_cache" {
  bucket = aws_s3_bucket.turbo_cache.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.data.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "turbo_cache" {
  bucket = aws_s3_bucket.turbo_cache.id
  rule {
    id     = "expire-cache-after-7-days"
    status = "Enabled"
    filter {}
    expiration { days = 7 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

data "aws_iam_policy_document" "turbo_cache_bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.turbo_cache.arn, "${aws_s3_bucket.turbo_cache.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyCacheDataOutsideServiceRoles"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:*"]
    resources = ["${aws_s3_bucket.turbo_cache.arn}/*"]
    dynamic "condition" {
      for_each = length(var.cache_service_role_arns) == 0 ? [] : [var.cache_service_role_arns]
      content {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = condition.value
      }
    }
  }

  statement {
    sid    = "DenyCacheListingOutsideServiceRoles"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.turbo_cache.arn]
    # HeadBucket refreshes have no max-keys context. Object listings always do.
    condition {
      test     = "NumericGreaterThan"
      variable = "s3:max-keys"
      values   = ["0"]
    }
    dynamic "condition" {
      for_each = length(var.cache_service_role_arns) == 0 ? [] : [var.cache_service_role_arns]
      content {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = condition.value
      }
    }
  }

  statement {
    sid    = "DenyCacheVersionAndMultipartListingOutsideServiceRoles"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:ListBucketVersions", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.turbo_cache.arn]
    dynamic "condition" {
      for_each = length(var.cache_service_role_arns) == 0 ? [] : [var.cache_service_role_arns]
      content {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = condition.value
      }
    }
  }
}

resource "aws_s3_bucket_policy" "turbo_cache" {
  bucket = aws_s3_bucket.turbo_cache.id
  policy = data.aws_iam_policy_document.turbo_cache_bucket.json
}

data "aws_iam_policy_document" "turbo_cache_service" {
  statement {
    sid       = "ReadWriteCacheObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.turbo_cache.arn}/*"]
  }
  statement {
    sid       = "UseCacheKeyThroughS3"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${data.aws_region.current.region}.${data.aws_partition.current.dns_suffix}"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [aws_s3_bucket.turbo_cache.arn]
    }
  }
}

resource "aws_ssm_parameter" "turbo_cache_bucket_name" {
  name  = "/mcc/${var.environment}/turbo-cache/bucket-name"
  type  = "String"
  value = aws_s3_bucket.turbo_cache.id
}

resource "aws_ssm_parameter" "turbo_cache_key_arn" {
  name  = "/mcc/${var.environment}/turbo-cache/data-key-arn"
  type  = "String"
  value = aws_kms_key.data.arn
}
