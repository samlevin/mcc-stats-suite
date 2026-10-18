# Lets the Terrateam role manage the CDKToolkitLocal stack and the IAM resources
# CloudFormation creates for it with the caller's credentials. PowerUserAccess
# covers the stack's S3, ECR, KMS, and SSM resources. Every role the stack
# creates is named cdk-mcclocal1-* and every managed policy
# mcc-stats-suite-local-*, which scripts/local-cdk-bootstrap.test.mjs checks
# against the template from scripts/local-cdk-bootstrap.mjs.
locals {
  local_cdk_toolkit_stack_name  = "CDKToolkitLocal"
  local_cdk_role_name_pattern   = "cdk-mcclocal1-*"
  local_cdk_policy_name_pattern = "mcc-stats-suite-local-*"

  local_cdk_toolkit_stack_arn = "arn:${local.partition}:cloudformation:*:${local.account_id}:stack/${local.local_cdk_toolkit_stack_name}/*"
  local_cdk_role_arn          = "arn:${local.partition}:iam::${local.account_id}:role/${local.local_cdk_role_name_pattern}"
  local_cdk_policy_arn        = "arn:${local.partition}:iam::${local.account_id}:policy/${local.local_cdk_policy_name_pattern}"
}

data "aws_iam_policy_document" "terrateam_local_cdk_bootstrap_management" {
  # Stack, change set, stack policy, and termination protection actions all
  # authorize against the stack ARN.
  statement {
    sid       = "ManageLocalToolkitStack"
    effect    = "Allow"
    actions   = ["cloudformation:*"]
    resources = [local.local_cdk_toolkit_stack_arn]
  }

  statement {
    sid    = "ManageLocalBootstrapRoles"
    effect = "Allow"
    actions = [
      "iam:CreateRole", "iam:GetRole", "iam:DeleteRole", "iam:UpdateRole",
      "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy",
      "iam:TagRole", "iam:UntagRole", "iam:ListRoleTags",
      "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:PutRolePolicy",
      "iam:DeleteRolePolicy", "iam:ListAttachedRolePolicies",
      "iam:DetachRolePolicy", "iam:ListInstanceProfilesForRole",
    ]
    resources = [local.local_cdk_role_arn]
  }

  # AttachRolePolicy and PutRolePermissionsBoundary accept only the local
  # policies, so a template that attaches any other policy, such as the stock
  # execution role's AdministratorAccess, fails.
  statement {
    sid       = "AttachOnlyLocalPolicies"
    effect    = "Allow"
    actions   = ["iam:AttachRolePolicy"]
    resources = [local.local_cdk_role_arn]
    condition {
      test     = "ArnLike"
      variable = "iam:PolicyARN"
      values   = [local.local_cdk_policy_arn]
    }
  }

  statement {
    sid       = "SetOnlyLocalBoundaries"
    effect    = "Allow"
    actions   = ["iam:PutRolePermissionsBoundary"]
    resources = [local.local_cdk_role_arn]
    condition {
      test     = "ArnLike"
      variable = "iam:PermissionsBoundary"
      values   = [local.local_cdk_policy_arn]
    }
  }

  statement {
    sid    = "ManageLocalPolicies"
    effect = "Allow"
    actions = [
      "iam:CreatePolicy", "iam:GetPolicy", "iam:DeletePolicy",
      "iam:CreatePolicyVersion", "iam:GetPolicyVersion", "iam:ListPolicyVersions",
      "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy", "iam:UntagPolicy", "iam:ListPolicyTags",
      "iam:ListEntitiesForPolicy",
    ]
    resources = [local.local_cdk_policy_arn]
  }
}

resource "aws_iam_role_policy" "terrateam_local_cdk_bootstrap_management" {
  count  = var.create_terrateam_role && var.manage_local_cdk_bootstrap ? 1 : 0
  name   = "manage-local-cdk-bootstrap"
  role   = aws_iam_role.terrateam[0].id
  policy = data.aws_iam_policy_document.terrateam_local_cdk_bootstrap_management.json
}
