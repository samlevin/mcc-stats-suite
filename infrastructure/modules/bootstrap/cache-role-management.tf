# Foundation owns the cache workload role; bootstrap delegates only its lifecycle.
locals {
  github_cache_role_arn = "arn:${local.partition}:iam::${local.account_id}:role/${var.project_name}-${var.environment}-github-turbo-cache"
}

data "aws_iam_policy_document" "terrateam_cache_role_management" {
  statement {
    sid       = "CreateBoundedCacheRole"
    effect    = "Allow"
    actions   = ["iam:CreateRole"]
    resources = [local.github_cache_role_arn]
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
    ]
    resources = [local.github_cache_role_arn]
  }
}

resource "aws_iam_role_policy" "terrateam_cache_role_management" {
  count  = var.create_terrateam_role ? 1 : 0
  name   = "manage-bounded-turbo-cache-role"
  role   = aws_iam_role.terrateam[0].id
  policy = data.aws_iam_policy_document.terrateam_cache_role_management.json
}
