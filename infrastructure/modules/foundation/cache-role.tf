locals {
  cache_role_name          = "${local.name}-github-turbo-cache"
  cache_role_arn           = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${local.cache_role_name}"
  cache_role_arns          = setunion(var.cache_service_role_arns, var.create_github_cache_role ? toset([local.cache_role_arn]) : toset([]))
  cache_subject_repository = coalesce(var.github_oidc_subject_repository, var.cache_github_repository)
}

data "aws_iam_policy_document" "cache_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = concat(["repo:${local.cache_subject_repository}:environment:${var.environment}"], var.environment == "dev" ? ["repo:${local.cache_subject_repository}:ref:refs/heads/main"] : [])
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:ref"
      values   = ["refs/heads/main"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository"
      values   = [var.cache_github_repository]
    }
  }
}

resource "aws_iam_role" "github_cache" {
  count                = var.create_github_cache_role ? 1 : 0
  name                 = local.cache_role_name
  assume_role_policy   = data.aws_iam_policy_document.cache_assume_role.json
  permissions_boundary = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:policy/${var.project_name}-workload-boundary"
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_cache" {
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
  statement {
    sid       = "ReadWriteCacheObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"]
    resources = ["${aws_s3_bucket.turbo_cache.arn}/turbogha/${var.environment}/*"]
  }
  statement {
    sid       = "ListCacheHashCandidates"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.turbo_cache.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["turbogha/${var.environment}/*"]
    }
  }
  statement {
    sid       = "ReadCacheContracts"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = [for name in ["bucket-name", "data-key-arn"] : "arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/mcc/${var.environment}/turbo-cache/${name}"]
  }
}

resource "aws_iam_role_policy" "github_cache" {
  count  = var.create_github_cache_role ? 1 : 0
  name   = "turbo-cache"
  role   = aws_iam_role.github_cache[0].id
  policy = data.aws_iam_policy_document.github_cache.json
}
