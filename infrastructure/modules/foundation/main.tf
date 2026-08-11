data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name = "${var.project_name}-${var.environment}"
}

resource "aws_kms_key" "data" {
  description             = "${local.name} application data"
  deletion_window_in_days = var.environment == "prod" ? 30 : 7
  enable_key_rotation     = true
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-application-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_s3_bucket" "raw_email" {
  bucket        = "${local.name}-${data.aws_caller_identity.current.account_id}-raw-email"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket" "attachments" {
  bucket        = "${local.name}-${data.aws_caller_identity.current.account_id}-attachments"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket" "output" {
  bucket        = "${local.name}-${data.aws_caller_identity.current.account_id}-match-output"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket" "evidence" {
  bucket              = "${local.name}-${data.aws_caller_identity.current.account_id}-ocr-evidence"
  force_destroy       = var.force_destroy
  object_lock_enabled = true
}

locals {
  buckets = {
    raw_email   = aws_s3_bucket.raw_email.id
    attachments = aws_s3_bucket.attachments.id
    output      = aws_s3_bucket.output.id
    evidence    = aws_s3_bucket.evidence.id
  }
}

resource "aws_s3_bucket_public_access_block" "data" {
  for_each = local.buckets
  bucket   = each.value

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "data" {
  for_each = local.buckets
  bucket   = each.value
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = 365
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "raw_email" {
  bucket = aws_s3_bucket.raw_email.id
  rule {
    id     = "expire-raw-mime-after-90-days"
    status = "Enabled"
    filter {}
    expiration { days = 90 }
    noncurrent_version_expiration { noncurrent_days = 1 }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "raw_email" {
  bucket = aws_s3_bucket.raw_email.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "application" {
  for_each = {
    attachments = aws_s3_bucket.attachments.id
    output      = aws_s3_bucket.output.id
    evidence    = aws_s3_bucket.evidence.id
  }
  bucket = each.value
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.data.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_notification" "raw_email" {
  bucket      = aws_s3_bucket.raw_email.id
  eventbridge = true
}

data "aws_iam_policy_document" "raw_email" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.raw_email.arn, "${aws_s3_bucket.raw_email.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "AllowSesToStoreRawEmail"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.raw_email.arn}/incoming/*"]
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "AWS:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:ses:*:${data.aws_caller_identity.current.account_id}:receipt-rule-set/*"]
    }
  }
}

resource "aws_s3_bucket_policy" "raw_email" {
  bucket = aws_s3_bucket.raw_email.id
  policy = data.aws_iam_policy_document.raw_email.json
}

resource "aws_ssm_parameter" "raw_email_bucket_name" {
  name  = "/mcc/${var.environment}/match-to-csv/raw-email-bucket-name"
  type  = "String"
  value = aws_s3_bucket.raw_email.id
}

resource "aws_ssm_parameter" "attachments_bucket_name" {
  name  = "/mcc/${var.environment}/match-to-csv/attachments-bucket-name"
  type  = "String"
  value = aws_s3_bucket.attachments.id
}

resource "aws_ssm_parameter" "output_bucket_name" {
  name  = "/mcc/${var.environment}/match-to-csv/output-bucket-name"
  type  = "String"
  value = aws_s3_bucket.output.id
}

resource "aws_ssm_parameter" "data_key_arn" {
  name  = "/mcc/${var.environment}/match-to-csv/data-key-arn"
  type  = "String"
  value = aws_kms_key.data.arn
}

resource "aws_ssm_parameter" "evidence_bucket_name" {
  name  = "/mcc/${var.environment}/match-to-csv/evidence-bucket-name"
  type  = "String"
  value = aws_s3_bucket.evidence.id
}
