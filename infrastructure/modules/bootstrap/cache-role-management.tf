# Foundation owns the cache workload roles; bootstrap delegates only their
# lifecycle. Dev adds the read-only role that pull requests use.
locals {
  github_cache_role_arn  = "arn:${local.partition}:iam::${local.account_id}:role/${var.project_name}-${var.environment}-github-turbo-cache"
  github_cache_role_arns = var.environment == "dev" ? [local.github_cache_role_arn, "${local.github_cache_role_arn}-read"] : [local.github_cache_role_arn]
}

data "aws_iam_policy_document" "terrateam_cache_role_management" {
  statement {
    sid       = "CreateBoundedCacheRole"
    effect    = "Allow"
    actions   = ["iam:CreateRole"]
    resources = local.github_cache_role_arns
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.workload_boundary.arn]
    }
  }
  statement {
    sid    = "ManageOnlyCacheRole"
    effect = "Allow"
    actions = [
      "iam:GetRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateRoleDescription",
      "iam:UpdateAssumeRolePolicy", "iam:ListRolePolicies", "iam:GetRolePolicy",
      "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:ListAttachedRolePolicies",
      "iam:TagRole", "iam:UntagRole", "iam:ListRoleTags",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = local.github_cache_role_arns
  }
}

resource "aws_iam_role_policy" "terrateam_cache_role_management" {
  count  = var.create_terrateam_role ? 1 : 0
  name   = "manage-bounded-turbo-cache-role"
  role   = aws_iam_role.terrateam[0].id
  policy = data.aws_iam_policy_document.terrateam_cache_role_management.json
}
