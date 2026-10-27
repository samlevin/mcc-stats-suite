locals {
  cache_role_name          = "${local.name}-github-turbo-cache"
  cache_role_arn           = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${local.cache_role_name}"
  cache_read_role_name     = "${local.cache_role_name}-read"
  cache_read_role_arn      = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${local.cache_read_role_name}"
  cache_role_arns          = setunion(var.cache_service_role_arns, local.github_cache_role ? toset([local.cache_role_arn]) : toset([]), local.github_cache_read_role ? toset([local.cache_read_role_arn]) : toset([]))
  cache_subject_repository = var.github_oidc_subject_repository == null ? "" : var.github_oidc_subject_repository
  // The roles trust only the repository this foundation is deployed for, named
  // by its subject repository with any immutable IDs removed, so a fork's role
  // trusts the fork and never upstream. Without a subject there is no role.
  cache_github_repository = replace(local.cache_subject_repository, "/@[0-9]+/", "")
  github_cache_role       = var.create_github_cache_role && local.cache_subject_repository != ""
  // Only dev CI validates pull requests, so only dev has the read-only role.
  github_cache_read_role = local.github_cache_role && var.environment == "dev"
}

# Reuse the bootstrap OIDC provider and workload boundary. Dev trusts main CI
# and the protected dev environment; prod trusts only its protected environment.
# Both require main, and neither accepts a pull request subject.
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
      values   = [local.cache_github_repository]
    }
  }
}

resource "aws_iam_role" "github_cache" {
  count                = local.github_cache_role ? 1 : 0
  name                 = local.cache_role_name
  assume_role_policy   = data.aws_iam_policy_document.cache_assume_role.json
  permissions_boundary = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:policy/${var.project_name}-workload-boundary"
  max_session_duration = 3600
}

# The v2 S3 cache provider calls ListObjectsV2 before GetObject, so the managed
# role adds prefix-scoped listing to object read/write and multipart abort. It
# cannot delete objects, read evidence or another environment's cache, administer
# IAM, or use KMS directly. S3 lifecycle owns seven-day expiry; action cleanup
# options are omitted. CI supplies an explicit temporary cache session, including
# its session token, independently of later deployment credentials.
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
    resources = [for name in ["bucket-name", "data-key-arn"] : "arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/mcc-ci/${var.environment}/turbo-cache/${name}"]
  }
}

resource "aws_iam_role_policy" "github_cache" {
  count  = local.github_cache_role ? 1 : 0
  name   = "turbo-cache"
  role   = aws_iam_role.github_cache[0].id
  policy = data.aws_iam_policy_document.github_cache.json
}

# Same-repo pull requests read the dev cache that main CI writes. This role
# trusts only this repository's pull_request subject, which the write role
# rejects, and it cannot write, so pull request code cannot poison the cache.
# Fork pull requests get no OIDC token and run uncached.
data "aws_iam_policy_document" "cache_read_assume_role" {
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
      values   = ["repo:${local.cache_subject_repository}:pull_request"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository"
      values   = [local.cache_github_repository]
    }
  }
}

resource "aws_iam_role" "github_cache_read" {
  count                = local.github_cache_read_role ? 1 : 0
  name                 = local.cache_read_role_name
  assume_role_policy   = data.aws_iam_policy_document.cache_read_assume_role.json
  permissions_boundary = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:policy/${var.project_name}-workload-boundary"
  max_session_duration = 3600
}

# The write role's grant without PutObject, multipart abort, or GenerateDataKey.
data "aws_iam_policy_document" "github_cache_read" {
  statement {
    sid       = "DecryptCacheObjectsThroughS3"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
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
    sid       = "ReadCacheObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
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
    resources = [for name in ["bucket-name", "data-key-arn"] : "arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/mcc-ci/${var.environment}/turbo-cache/${name}"]
  }
}

resource "aws_iam_role_policy" "github_cache_read" {
  count  = local.github_cache_read_role ? 1 : 0
  name   = "turbo-cache-read"
  role   = aws_iam_role.github_cache_read[0].id
  policy = data.aws_iam_policy_document.github_cache_read.json
}
