# The dev foundation will own the local CDK permission policies; bootstrap
# delegates only their lifecycle. The names match the ManagedPolicyName values
# in scripts/local-cdk-bootstrap.mjs, which scripts/local-cdk-bootstrap.test.mjs
# checks.
locals {
  local_cdk_policy_names = [
    "mcc-stats-suite-local-workload-boundary",
    "mcc-stats-suite-local-cdk-execution-boundary",
    "mcc-stats-suite-local-cdk-execution",
    "mcc-stats-suite-local-cdk-execution-compute",
    "mcc-stats-suite-local-cdk-execution-events",
  ]
  local_cdk_policy_arns = [
    for name in local.local_cdk_policy_names :
    "arn:${local.partition}:iam::${local.account_id}:policy/${name}"
  ]
}

data "aws_iam_policy_document" "terrateam_local_cdk_policy_management" {
  # Policy actions only: attaching a policy is a role, user, or group action,
  # so these resources cannot grant it.
  statement {
    sid    = "ManageOnlyLocalCdkPolicies"
    effect = "Allow"
    actions = [
      "iam:CreatePolicy", "iam:GetPolicy", "iam:DeletePolicy",
      "iam:CreatePolicyVersion", "iam:GetPolicyVersion", "iam:ListPolicyVersions",
      "iam:DeletePolicyVersion", "iam:TagPolicy", "iam:UntagPolicy",
      "iam:ListPolicyTags",
    ]
    resources = local.local_cdk_policy_arns
  }
}

resource "aws_iam_role_policy" "terrateam_local_cdk_policy_management" {
  count  = var.create_terrateam_role && var.manage_local_cdk_policies ? 1 : 0
  name   = "manage-local-cdk-policies"
  role   = aws_iam_role.terrateam[0].id
  policy = data.aws_iam_policy_document.terrateam_local_cdk_policy_management.json
}
