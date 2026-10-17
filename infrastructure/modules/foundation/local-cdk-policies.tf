# The local CDK permission policies that the mcclocal1 bootstrap
# (scripts/local-cdk-bootstrap.mjs) attaches by name. Only dev has local
# deployments. The workload boundary caps every role an ephemeral stack
# creates; the other four cap and grant the local CloudFormation execution
# role. docs/local-cdk-bootstrap-design.md describes what they allow.
#
# The names are account-wide and must match the bootstrap grant in
# infrastructure/modules/bootstrap/local-cdk-policy-management.tf, the ARNs in
# scripts/local-cdk-bootstrap.mjs, and the runtime boundary in
# packages/cdk-config. tests/local-cdk-policy-names.tftest.hcl checks all
# three, and tests/local-cdk-policies.tftest.hcl checks what they allow.
locals {
  # Matches APPLICATIONS in scripts/cdk-targets.mjs.
  local_cdk_applications = ["admin", "data-pipeline", "match-to-csv", "ocr-quality", "player"]
  local_cdk_policy_names = {
    workload_boundary  = "mcc-stats-suite-local-workload-boundary"
    execution_boundary = "mcc-stats-suite-local-cdk-execution-boundary"
    execution          = "mcc-stats-suite-local-cdk-execution"
    execution_compute  = "mcc-stats-suite-local-cdk-execution-compute"
    execution_events   = "mcc-stats-suite-local-cdk-execution-events"
  }

  local_cdk_partition = data.aws_partition.current.partition
  local_cdk_region    = data.aws_region.current.region
  local_cdk_account   = data.aws_caller_identity.current.account_id
  local_cdk_arn       = "arn:${local.local_cdk_partition}"
  local_cdk_scope     = "${local.local_cdk_region}:${local.local_cdk_account}"

  local_cdk_runtime_boundary_arn = "${local.local_cdk_arn}:iam::${local.local_cdk_account}:policy/${local.local_cdk_policy_names.workload_boundary}"

  # Name-anchored per service, so neither unrelated names such as sysadmin-*
  # nor aliases, executions, or streams of other resources match.
  local_cdk_functions      = [for app in local.local_cdk_applications : "${local.local_cdk_arn}:lambda:${local.local_cdk_scope}:function:${app}-e-*"]
  local_cdk_state_machines = [for app in local.local_cdk_applications : "${local.local_cdk_arn}:states:${local.local_cdk_scope}:stateMachine:${app}-e-*"]
  local_cdk_queues         = [for app in local.local_cdk_applications : "${local.local_cdk_arn}:sqs:${local.local_cdk_scope}:${app}-e-*"]
  local_cdk_log_groups     = [for app in local.local_cdk_applications : "${local.local_cdk_arn}:logs:${local.local_cdk_scope}:log-group:/aws/*/${app}-e-*"]
  local_cdk_compute = concat(
    local.local_cdk_functions,
    local.local_cdk_state_machines,
    [for app in local.local_cdk_applications : "${local.local_cdk_arn}:states:${local.local_cdk_scope}:execution:${app}-e-*"],
    local.local_cdk_queues,
    local.local_cdk_log_groups,
  )
  local_cdk_rules = [for app in local.local_cdk_applications : "${local.local_cdk_arn}:events:${local.local_cdk_scope}:rule/${app}-e-*"]
  local_cdk_roles = [for app in local.local_cdk_applications : "${local.local_cdk_arn}:iam::${local.local_cdk_account}:role/mcc-local/${app}-e-*"]

  local_cdk_bootstrap_version = "${local.local_cdk_arn}:ssm:${local.local_cdk_scope}:parameter/cdk-bootstrap/mcclocal1/version"
  # Everything under /mcc/<environment>/ is application config; CI and other
  # parameters applications must not read live under other prefixes, such as
  # /mcc-ci/<environment>/. One prefix therefore covers every application.
  local_cdk_application_parameters = "${local.local_cdk_arn}:ssm:${local.local_cdk_scope}:parameter/mcc/${var.environment}/*"
  # CDK's default staging bucket name for the mcclocal1 qualifier.
  local_cdk_staging_bucket   = "${local.local_cdk_arn}:s3:::cdk-mcclocal1-assets-${local.local_cdk_account}-${local.local_cdk_region}"
  local_cdk_via_s3           = "s3.${local.local_cdk_region}.${data.aws_partition.current.dns_suffix}"
  local_cdk_compute_services = ["lambda", "states", "sqs", "logs"]
}

data "aws_iam_policy_document" "local_cdk_workload_boundary" {
  statement {
    sid    = "WorkloadActions"
    effect = "Allow"
    actions = [
      "kms:DescribeKey",
      "textract:AnalyzeDocument",
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
      "logs:DescribeLogGroups",
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "WriteEphemeralLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = local.local_cdk_log_groups
  }

  # Functions read single dev application parameters at runtime, such as
  # match-to-csv's sender allowlist and the submission address it checks. The
  # boundary allows any application's; each function's own policy still names
  # the exact parameters it reads.
  statement {
    sid       = "ReadApplicationParameters"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = [local.local_cdk_application_parameters]
  }

  # The app uses keys only for S3 server-side encryption.
  statement {
    sid       = "UseKeysThroughS3"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.local_cdk_via_s3]
    }
  }

  # Each stack tags its roles Ephemeral=<name>, so a runtime reaches only its
  # own ephemeral/<name>/ and incoming/<name>/ objects. Shared dev evidence is
  # outside both.
  statement {
    sid       = "WriteEphemeralObjects"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${local.local_cdk_arn}:s3:::*/ephemeral/$${aws:PrincipalTag/Ephemeral}/*"]
  }

  statement {
    sid     = "ReadEphemeralObjects"
    effect  = "Allow"
    actions = ["s3:GetObject*"]
    resources = [
      "${local.local_cdk_arn}:s3:::*/ephemeral/$${aws:PrincipalTag/Ephemeral}/*",
      "${local.local_cdk_arn}:s3:::*/incoming/$${aws:PrincipalTag/Ephemeral}/*",
    ]
  }

  statement {
    sid       = "ListEphemeralObjects"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = ["*"]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["ephemeral/$${aws:PrincipalTag/Ephemeral}/*"]
    }
  }

  # IAM's * also matches /, so the allows above would otherwise match these
  # prefixes anywhere in a key, such as submissions/ephemeral/<name>/ in shared
  # evidence.
  statement {
    sid     = "EphemeralPrefixesAtKeyRoot"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      "${local.local_cdk_arn}:s3:::*/*/ephemeral/*",
      "${local.local_cdk_arn}:s3:::*/*/incoming/*",
    ]
  }

  # S3 ARNs carry no account, so the object allows would also match other
  # accounts.
  statement {
    sid       = "OnlyThisAccountsBuckets"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "s3:ResourceAccount"
      values   = ["$${aws:PrincipalAccount}"]
    }
    condition {
      test     = "Null"
      variable = "s3:ResourceAccount"
      values   = ["false"]
    }
  }

  statement {
    sid       = "ProtectSharedInboundEmail"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = ["${local.local_cdk_arn}:s3:::*/incoming/${var.environment}/*"]
  }

  statement {
    sid    = "UseEphemeralCompute"
    effect = "Allow"
    actions = [
      "lambda:InvokeFunction",
      "states:StartExecution",
      "states:DescribeExecution",
      "states:StopExecution",
      "states:GetExecutionHistory",
      "sqs:SendMessage",
    ]
    resources = local.local_cdk_compute
  }

  statement {
    sid       = "NoDeploymentOrIdentityAdministration"
    effect    = "Deny"
    actions   = ["iam:*", "sts:*", "cloudformation:*", "account:*", "organizations:*"]
    resources = ["*"]
  }

  statement {
    sid     = "ProtectStableBootstrapAssets"
    effect  = "Deny"
    actions = ["s3:*", "ecr:*"]
    resources = [
      "${local.local_cdk_arn}:s3:::cdk-hnb659fds-*",
      "${local.local_cdk_arn}:s3:::cdk-hnb659fds-*/*",
      "${local.local_cdk_arn}:ecr:${local.local_cdk_scope}:repository/cdk-hnb659fds-*",
    ]
  }
}

# The execution role's identity policies hold the scoped grants, split to fit
# the managed policy size limit. This boundary caps the role at those services
# and denies deployment and identity administration.
data "aws_iam_policy_document" "local_cdk_execution_boundary" {
  statement {
    sid    = "ExecutionServices"
    effect = "Allow"
    actions = concat(
      [for service in local.local_cdk_compute_services : "${service}:*"],
      [
        "events:*",
        "ses:*ReceiptRule*",
        "s3:GetObject",
        "s3:GetBucketLocation",
        "kms:Decrypt",
        "kms:DescribeKey",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "iam:*Role*",
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
      ],
    )
    resources = ["*"]
  }

  statement {
    sid    = "NoDeploymentOrIdentityAdministration"
    effect = "Deny"
    actions = [
      "cloudformation:*",
      "sts:*",
      "account:*",
      "organizations:*",
      "iam:DeleteRolePermissionsBoundary",
      "iam:CreateServiceLinkedRole",
    ]
    resources = ["*"]
  }
}

data "aws_iam_policy_document" "local_cdk_execution_compute" {
  statement {
    sid       = "ManageEphemeralCompute"
    effect    = "Allow"
    actions   = [for service in local.local_cdk_compute_services : "${service}:*"]
    resources = local.local_cdk_compute
  }

  # The AWS::Logs::LogGroup handler lists groups, which IAM checks against no
  # group ARN.
  statement {
    sid       = "DescribeLogGroups"
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
}

data "aws_iam_policy_document" "local_cdk_execution_events" {
  statement {
    sid    = "ManageEphemeralRules"
    effect = "Allow"
    actions = [
      "events:DescribeRule",
      "events:DeleteRule",
      "events:EnableRule",
      "events:DisableRule",
      "events:ListTargetsByRule",
      "events:RemoveTargets",
      "events:TagResource",
      "events:UntagResource",
      "events:ListTagsForResource",
    ]
    resources = local.local_cdk_rules
  }

  # Rules may match only S3 events, so a local template cannot subscribe to the
  # shared workflows' Step Functions events.
  statement {
    sid       = "PutEphemeralRules"
    effect    = "Allow"
    actions   = ["events:PutRule"]
    resources = local.local_cdk_rules
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "events:source"
      values   = ["aws.s3"]
    }
    condition {
      test     = "Null"
      variable = "events:source"
      values   = ["false"]
    }
  }

  # Rules may deliver only to ephemeral compute.
  statement {
    sid       = "PutEphemeralTargets"
    effect    = "Allow"
    actions   = ["events:PutTargets"]
    resources = local.local_cdk_rules
    condition {
      test     = "ForAllValues:ArnLike"
      variable = "events:TargetArn"
      values   = concat(local.local_cdk_functions, local.local_cdk_state_machines, local.local_cdk_queues)
    }
    condition {
      test     = "Null"
      variable = "events:TargetArn"
      values   = ["false"]
    }
  }
}

data "aws_iam_policy_document" "local_cdk_execution" {
  statement {
    sid    = "ManageEphemeralReceiptRules"
    effect = "Allow"
    actions = [
      "ses:CreateReceiptRule",
      "ses:UpdateReceiptRule",
      "ses:DeleteReceiptRule",
      "ses:DescribeReceiptRule",
      "ses:DescribeReceiptRuleSet",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "ReadLambdaAssets"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetBucketLocation"]
    resources = [local.local_cdk_staging_bucket, "${local.local_cdk_staging_bucket}/*"]
  }

  # Lambda reads the code object with the caller's credentials; the staging
  # bucket uses SSE-KMS.
  statement {
    sid       = "DecryptLambdaAssets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.local_cdk_via_s3]
    }
  }

  statement {
    sid       = "ReadConfiguration"
    effect    = "Allow"
    actions   = ["kms:DescribeKey", "iam:GetPolicy", "iam:GetPolicyVersion"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadDeploymentParameters"
    effect    = "Allow"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = [local.local_cdk_bootstrap_version, local.local_cdk_application_parameters]
  }

  # Roles under the local path exist only through CreateRole with the runtime
  # boundary.
  statement {
    sid       = "CreateBoundedRoles"
    effect    = "Allow"
    actions   = ["iam:CreateRole", "iam:PutRolePermissionsBoundary"]
    resources = local.local_cdk_roles
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.local_cdk_runtime_boundary_arn]
    }
  }

  statement {
    sid       = "ChangeBoundedRolePolicies"
    effect    = "Allow"
    actions   = ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy"]
    resources = local.local_cdk_roles
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.local_cdk_runtime_boundary_arn]
    }
  }

  statement {
    sid    = "ManageEphemeralRoles"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:DeleteRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:ListInstanceProfilesForRole",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:ListRoleTags",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
    ]
    resources = local.local_cdk_roles
  }

  statement {
    sid       = "PassRuntimeRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = local.local_cdk_roles
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com", "states.amazonaws.com", "events.amazonaws.com"]
    }
  }
}

locals {
  local_cdk_documents = {
    workload_boundary  = data.aws_iam_policy_document.local_cdk_workload_boundary.minified_json
    execution_boundary = data.aws_iam_policy_document.local_cdk_execution_boundary.minified_json
    execution          = data.aws_iam_policy_document.local_cdk_execution.minified_json
    execution_compute  = data.aws_iam_policy_document.local_cdk_execution_compute.minified_json
    execution_events   = data.aws_iam_policy_document.local_cdk_execution_events.minified_json
  }
}

# No description: CloudFormation created these without one, and a description
# change replaces the policy, which would leave the local roles without it.
resource "aws_iam_policy" "local_cdk" {
  for_each = var.create_local_cdk_policies ? local.local_cdk_policy_names : {}
  name     = each.value
  path     = "/"
  policy   = local.local_cdk_documents[each.key]
}
