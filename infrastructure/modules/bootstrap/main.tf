data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  ci_enabled = var.create_terrateam_role || var.create_cdk_deploy_role

  state_bucket_name = coalesce(
    var.state_bucket_name,
    "${var.project_name}-tofu-state-${local.account_id}-${var.aws_region}",
  )

  github_subject_repository = coalesce(
    var.github_oidc_subject_repository,
    "${var.github_organization}/${var.github_repository}",
  )
  github_environment_name  = coalesce(var.github_environment_name, var.environment)
  terrateam_github_subject = "repo:${local.github_subject_repository}:*"
  cdk_github_subject       = "repo:${local.github_subject_repository}:environment:${local.github_environment_name}"
  terrateam_workflow_ref   = "${var.github_organization}/${var.github_repository}/${var.terrateam_workflow_path}@*"
  terrateam_role_name      = coalesce(var.terrateam_role_name, "${var.project_name}-${var.environment}-terrateam")
  cdk_deploy_role_name     = coalesce(var.cdk_deploy_role_name, "${var.project_name}-${var.environment}-github-cdk-deploy")

  common_tags = merge(
    {
      Application = var.project_name
      Environment = var.environment
      ManagedBy   = "opentofu"
      Repository  = "${var.github_organization}/${var.github_repository}"
    },
    var.tags,
  )
}

resource "aws_s3_bucket" "state" {
  bucket        = local.state_bucket_name
  force_destroy = false
  tags          = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "state-history"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_bucket.json
}

data "aws_iam_policy_document" "workload_boundary" {
  statement {
    sid       = "AllowWorkloadPermissions"
    effect    = "Allow"
    actions   = ["*"]
    resources = ["*"]
  }

  statement {
    sid    = "DenyIdentityAndOrganizationAdministration"
    effect = "Deny"
    actions = [
      "account:*",
      "iam:*",
      "organizations:*",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "workload_boundary" {
  name        = "${var.project_name}-workload-boundary"
  description = "Maximum permissions for ${var.project_name} application runtime roles"
  policy      = data.aws_iam_policy_document.workload_boundary.json
  tags        = local.common_tags
}

resource "aws_iam_openid_connect_provider" "github" {
  count = local.ci_enabled && var.github_oidc_provider_arn == null ? 1 : 0

  url  = "https://token.actions.githubusercontent.com"
  tags = local.common_tags

  client_id_list = ["sts.amazonaws.com"]
}

locals {
  github_oidc_provider_arn = var.github_oidc_provider_arn != null ? var.github_oidc_provider_arn : (
    local.ci_enabled ? one(aws_iam_openid_connect_provider.github[*].arn) : null
  )
}

data "aws_iam_policy_document" "terrateam_assume_role" {
  count = var.create_terrateam_role ? 1 : 0

  statement {
    sid     = "GitHubActionsOidc"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.terrateam_github_subject]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:job_workflow_ref"
      values   = [local.terrateam_workflow_ref]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:actor"
      values   = ["terrateam-action[bot]"]
    }
  }
}

resource "aws_iam_role" "terrateam" {
  count = var.create_terrateam_role ? 1 : 0

  name                 = local.terrateam_role_name
  description          = "Terrateam OpenTofu deployment role for ${var.project_name} ${var.environment}"
  assume_role_policy   = data.aws_iam_policy_document.terrateam_assume_role[0].json
  max_session_duration = 3600
  tags                 = local.common_tags
}

resource "aws_iam_role_policy_attachment" "terrateam_power_user" {
  count = var.create_terrateam_role ? 1 : 0

  role       = aws_iam_role.terrateam[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/PowerUserAccess"
}

resource "aws_iam_role_policy_attachment" "terrateam_additional" {
  for_each = var.create_terrateam_role ? var.additional_terrateam_policy_arns : toset([])

  role       = aws_iam_role.terrateam[0].name
  policy_arn = each.value
}

data "aws_iam_policy_document" "cdk_deploy_assume_role" {
  count = var.create_cdk_deploy_role ? 1 : 0

  statement {
    sid     = "GitHubActionsEnvironment"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.cdk_github_subject]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository"
      values   = ["${var.github_organization}/${var.github_repository}"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:workflow"
      values   = [var.cdk_workflow_name]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:ref"
      values   = ["refs/heads/${var.github_deployment_branch}"]
    }
  }
}

resource "aws_iam_role" "cdk_deploy" {
  count = var.create_cdk_deploy_role ? 1 : 0

  name                 = local.cdk_deploy_role_name
  description          = "GitHub Actions CDK entry role for ${var.project_name} ${var.environment}"
  assume_role_policy   = data.aws_iam_policy_document.cdk_deploy_assume_role[0].json
  max_session_duration = 3600
  tags                 = local.common_tags
}

resource "aws_iam_role_policy_attachment" "cdk_deploy_power_user" {
  count = var.create_cdk_deploy_role ? 1 : 0

  role       = aws_iam_role.cdk_deploy[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/PowerUserAccess"
}

resource "aws_iam_role_policy_attachment" "cdk_deploy_additional" {
  for_each = var.create_cdk_deploy_role ? var.additional_cdk_deploy_policy_arns : toset([])

  role       = aws_iam_role.cdk_deploy[0].name
  policy_arn = each.value
}

data "aws_iam_policy_document" "cdk_bootstrap_roles" {
  statement {
    sid    = "UseCdkBootstrapRoles"
    effect = "Allow"

    actions = [
      "sts:AssumeRole",
    ]

    resources = [
      "arn:${local.partition}:iam::${local.account_id}:role/cdk-*-deploy-role-${local.account_id}-*",
      "arn:${local.partition}:iam::${local.account_id}:role/cdk-*-file-publishing-role-${local.account_id}-*",
      "arn:${local.partition}:iam::${local.account_id}:role/cdk-*-image-publishing-role-${local.account_id}-*",
      "arn:${local.partition}:iam::${local.account_id}:role/cdk-*-lookup-role-${local.account_id}-*",
    ]
  }
}

resource "aws_iam_role_policy" "cdk_bootstrap_roles" {
  count = var.create_cdk_deploy_role ? 1 : 0

  name   = "${var.project_name}-use-cdk-bootstrap-roles"
  role   = aws_iam_role.cdk_deploy[0].id
  policy = data.aws_iam_policy_document.cdk_bootstrap_roles.json
}
