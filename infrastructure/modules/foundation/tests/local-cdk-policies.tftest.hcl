# The local CDK permission policies, checked against the rules in
# docs/local-cdk-bootstrap-design.md. Only local plans run. Fake credentials
# and overrides prevent AWS calls while the real provider renders the policy
# documents.
#
# Paths in file() are relative to infrastructure/dev/foundation, the root
# scripts/tofu-checks.sh runs these tests through.
provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_region_validation      = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
}

override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "000000000000" }
}

override_data {
  target = data.aws_partition.current
  values = { partition = "aws", dns_suffix = "amazonaws.com" }
}

override_data {
  target = data.aws_region.current
  values = { region = "us-east-1" }
}

override_resource {
  target = aws_kms_key.data
  values = { arn = "arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000000" }
}

override_data {
  target = data.aws_ssm_parameters_by_path.match_to_csv
  values = {
    names  = ["/mcc/dev/match-to-csv/email-alias", "/mcc/prod/match-to-csv/email-alias"]
    values = ["example-alias", "example-alias"]
  }
}

variables {
  email_alias  = "example-alias"
  email_domain = "mail.example.com"
}

run "dev_creates_the_local_cdk_policies" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment               = "dev"
    create_local_cdk_policies = true
  }

  assert {
    condition     = length(aws_iam_policy.local_cdk) == 5
    error_message = "Dev creates the five local CDK policies; local-cdk-policy-names.tftest.hcl checks their names."
  }

  # A path or description change replaces a policy, which would leave the local
  # roles without it until the new one exists.
  assert {
    condition     = alltrue([for policy in aws_iam_policy.local_cdk : policy.path == "/" && (policy.description == null || policy.description == "")])
    error_message = "The policies keep the root path and no description, matching the policies CloudFormation created."
  }

  assert {
    condition = (
      jsondecode(aws_iam_policy.local_cdk["workload_boundary"].policy) == jsondecode(data.aws_iam_policy_document.local_cdk_workload_boundary.minified_json) &&
      jsondecode(aws_iam_policy.local_cdk["execution_boundary"].policy) == jsondecode(data.aws_iam_policy_document.local_cdk_execution_boundary.minified_json) &&
      jsondecode(aws_iam_policy.local_cdk["execution"].policy) == jsondecode(data.aws_iam_policy_document.local_cdk_execution.minified_json) &&
      jsondecode(aws_iam_policy.local_cdk["execution_compute"].policy) == jsondecode(data.aws_iam_policy_document.local_cdk_execution_compute.minified_json) &&
      jsondecode(aws_iam_policy.local_cdk["execution_events"].policy) == jsondecode(data.aws_iam_policy_document.local_cdk_execution_events.minified_json)
    )
    error_message = "Each policy uses its own document."
  }

  assert {
    condition     = alltrue([for policy in aws_iam_policy.local_cdk : length(policy.policy) < 6144])
    error_message = "Each policy stays below the 6,144-character IAM managed policy limit."
  }
}

run "dev_without_the_flag_creates_none" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables { environment = "dev" }

  assert {
    condition     = length(aws_iam_policy.local_cdk) == 0
    error_message = "The policies exist only where a root turns them on."
  }

  assert {
    condition = (
      length(aws_iam_policy.local_cdk) == 0 &&
      can(regex("(?m)^\\s*create_local_cdk_policies\\s*=\\s*true\\s*$", file("main.tf"))) &&
      !strcontains(file("../../prod/foundation/main.tf"), "create_local_cdk_policies")
    )
    error_message = "infrastructure/dev/foundation turns the local CDK policies on, and infrastructure/prod/foundation never mentions them."
  }
}

run "prod_creates_none" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables { environment = "prod" }

  assert {
    condition     = length(aws_iam_policy.local_cdk) == 0
    error_message = "Prod has no local CDK deployments and creates none of the policies."
  }
}

run "prod_rejects_the_policies" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment               = "prod"
    create_local_cdk_policies = true
  }
  expect_failures = [var.create_local_cdk_policies]
}

# Execution role: three identity policies within the execution boundary.
run "execution_manages_only_ephemeral_resources_by_name" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment               = "dev"
    create_local_cdk_policies = true
  }

  # One function, state machine, execution, queue, and log group pattern per
  # application, each anchored at <application>-e-.
  assert {
    condition = alltrue(flatten([
      for statement in concat(data.aws_iam_policy_document.local_cdk_execution_compute.statement, data.aws_iam_policy_document.local_cdk_execution_events.statement) : [
        for resource in statement.resources :
        statement.sid == "DescribeLogGroups" || can(regex("^arn:aws:(lambda:us-east-1:000000000000:function:|states:us-east-1:000000000000:(stateMachine|execution):|sqs:us-east-1:000000000000:|logs:us-east-1:000000000000:log-group:/aws/\\*/|events:us-east-1:000000000000:rule/)(admin|data-pipeline|match-to-csv|ocr-quality|player)-e-\\*$", resource))
      ]
    ]))
    error_message = "The execution role manages compute, log groups, and rules only by name under <application>-e-."
  }

  assert {
    condition     = length(one([for statement in data.aws_iam_policy_document.local_cdk_execution_compute.statement : statement if statement.sid == "ManageEphemeralCompute"]).resources) == 25 && length(one([for statement in data.aws_iam_policy_document.local_cdk_execution_events.statement : statement if statement.sid == "ManageEphemeralRules"]).resources) == 5
    error_message = "Every application gets one pattern per compute resource type and one rule pattern."
  }

  assert {
    condition     = one([for statement in data.aws_iam_policy_document.local_cdk_execution_compute.statement : statement if statement.sid == "DescribeLogGroups"]).actions == toset(["logs:DescribeLogGroups"])
    error_message = "Only listing log groups, which IAM checks against no group ARN, applies to every resource."
  }

  # Wildcard resources only where the service has no resource scoping or the
  # statement has its own condition.
  assert {
    condition = toset(flatten([
      for statement in concat(
        data.aws_iam_policy_document.local_cdk_execution.statement,
        data.aws_iam_policy_document.local_cdk_execution_compute.statement,
        data.aws_iam_policy_document.local_cdk_execution_events.statement,
      ) : contains(statement.resources, "*") ? [statement.sid] : []
    ])) == toset(["ManageEphemeralReceiptRules", "DecryptLambdaAssets", "ReadConfiguration", "DescribeLogGroups"])
    error_message = "Only receipt rules, decryption through S3, configuration reads, and log group listing apply to every resource."
  }

  assert {
    condition = (
      one([for statement in data.aws_iam_policy_document.local_cdk_execution.statement : statement if statement.sid == "ManageEphemeralReceiptRules"]).actions == toset(["ses:CreateReceiptRule", "ses:UpdateReceiptRule", "ses:DeleteReceiptRule", "ses:DescribeReceiptRule", "ses:DescribeReceiptRuleSet"]) &&
      one([for statement in data.aws_iam_policy_document.local_cdk_execution.statement : statement if statement.sid == "ReadConfiguration"]).actions == toset(["kms:DescribeKey", "iam:GetPolicy", "iam:GetPolicyVersion"])
    )
    error_message = "The execution role changes receipt rules but never receipt rule sets, and reads only key and policy metadata on every resource."
  }

  assert {
    condition = (
      one([for statement in data.aws_iam_policy_document.local_cdk_execution.statement : statement if statement.sid == "ReadLambdaAssets"]).resources == toset(["arn:aws:s3:::cdk-mcclocal1-assets-000000000000-us-east-1", "arn:aws:s3:::cdk-mcclocal1-assets-000000000000-us-east-1/*"]) &&
      toset([for condition in one([for statement in data.aws_iam_policy_document.local_cdk_execution.statement : statement if statement.sid == "DecryptLambdaAssets"]).condition : "${condition.test} ${condition.variable} ${join(",", condition.values)}"]) == toset(["StringEquals kms:ViaService s3.us-east-1.amazonaws.com"])
    )
    error_message = "The execution role reads only the local staging bucket and decrypts only through S3."
  }

  assert {
    condition     = one([for statement in data.aws_iam_policy_document.local_cdk_execution.statement : statement if statement.sid == "ReadDeploymentParameters"]).resources == toset(["arn:aws:ssm:us-east-1:000000000000:parameter/cdk-bootstrap/mcclocal1/version", "arn:aws:ssm:us-east-1:000000000000:parameter/mcc/dev/*"])
    error_message = "The execution role reads only the local bootstrap version and dev application parameters."
  }
}

run "execution_rules_match_only_s3_and_target_only_ephemeral_compute" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment               = "dev"
    create_local_cdk_policies = true
  }

  assert {
    condition = toset([
      for condition in one([for statement in data.aws_iam_policy_document.local_cdk_execution_events.statement : statement if statement.sid == "PutEphemeralRules"]).condition :
      "${condition.test} ${condition.variable} ${join(",", condition.values)}"
    ]) == toset(["ForAllValues:StringEquals events:source aws.s3", "Null events:source false"])
    error_message = "PutRule requires an event source, and every source must be aws.s3."
  }

  assert {
    condition = alltrue([
      for condition in one([for statement in data.aws_iam_policy_document.local_cdk_execution_events.statement : statement if statement.sid == "PutEphemeralTargets"]).condition :
      condition.test == "Null" ? condition.variable == "events:TargetArn" && toset(condition.values) == toset(["false"]) : (
        condition.test == "ForAllValues:ArnLike" && condition.variable == "events:TargetArn" && length(condition.values) == 15 &&
        alltrue([for target in condition.values : can(regex("^arn:aws:(lambda:us-east-1:000000000000:function:|states:us-east-1:000000000000:stateMachine:|sqs:us-east-1:000000000000:)(admin|data-pipeline|match-to-csv|ocr-quality|player)-e-\\*$", target))])
      )
    ]) && length(one([for statement in data.aws_iam_policy_document.local_cdk_execution_events.statement : statement if statement.sid == "PutEphemeralTargets"]).condition) == 2
    error_message = "PutTargets requires targets, and every target must be an ephemeral function, state machine, or queue."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.local_cdk_execution_events.statement :
      contains(statement.actions, "events:PutRule") || contains(statement.actions, "events:PutTargets") ? length(statement.condition) == 2 && length(statement.actions) == 1 : true
    ])
    error_message = "Creating rules and targets is allowed only through the conditional statements."
  }
}

run "execution_creates_and_changes_only_bounded_local_roles" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment               = "dev"
    create_local_cdk_policies = true
  }

  assert {
    condition = alltrue(flatten([
      for statement in data.aws_iam_policy_document.local_cdk_execution.statement : [
        for resource in statement.resources :
        can(regex("^arn:aws:iam::000000000000:role/mcc-local/(admin|data-pipeline|match-to-csv|ocr-quality|player)-e-\\*$", resource))
      ] if anytrue([for action in statement.actions : startswith(action, "iam:") && !contains(["iam:GetPolicy", "iam:GetPolicyVersion"], action)])
    ]))
    error_message = "Every role grant names only <application>-e- roles under /mcc-local/; roles at other paths stay out of reach."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.local_cdk_execution.statement :
      toset([for condition in statement.condition : "${condition.test} ${condition.variable} ${join(",", condition.values)}"]) == toset(["StringEquals iam:PermissionsBoundary arn:aws:iam::000000000000:policy/mcc-stats-suite-local-workload-boundary"])
      if contains(["CreateBoundedRoles", "ChangeBoundedRolePolicies"], statement.sid)
    ])
    error_message = "Creating roles and changing their policies require the local runtime boundary."
  }

  assert {
    condition = alltrue(flatten([
      for statement in data.aws_iam_policy_document.local_cdk_execution.statement : [
        for action in ["iam:CreateRole", "iam:PutRolePermissionsBoundary", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy"] :
        contains(["CreateBoundedRoles", "ChangeBoundedRolePolicies"], statement.sid) || !contains(statement.actions, action)
      ]
    ]))
    error_message = "No other statement grants role creation, boundary changes, or role policy changes."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.local_cdk_execution.statement :
      statement.sid == "PassRuntimeRoles" && toset([for condition in statement.condition : "${condition.test} ${condition.variable} ${join(",", sort(condition.values))}"]) == toset(["StringEquals iam:PassedToService events.amazonaws.com,lambda.amazonaws.com,states.amazonaws.com"])
      if contains(statement.actions, "iam:PassRole")
    ])
    error_message = "The execution role passes local roles only to Lambda, Step Functions, and EventBridge."
  }
}

run "execution_cannot_escalate_or_deploy" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment               = "dev"
    create_local_cdk_policies = true
  }

  # No identity allow pattern matches these actions.
  assert {
    condition = alltrue(flatten([
      for statement in concat(
        data.aws_iam_policy_document.local_cdk_execution.statement,
        data.aws_iam_policy_document.local_cdk_execution_compute.statement,
        data.aws_iam_policy_document.local_cdk_execution_events.statement,
        ) : [
        for action in statement.actions : [
          for forbidden in ["iam:DeleteRolePermissionsBoundary", "iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:CreateUser", "iam:CreateAccessKey", "sts:AssumeRole", "cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:DeleteStack", "ses:SetActiveReceiptRuleSet", "ses:CreateReceiptRuleSet", "ses:DeleteReceiptRuleSet"] :
          !can(regex("(?i)^${replace(action, "*", ".*")}$", forbidden))
        ]
      ] if statement.effect == "Allow"
    ]))
    error_message = "The execution role cannot change policies or boundaries, create users or keys, assume roles, change stacks, or change receipt rule sets."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.local_cdk_execution_boundary.statement :
      statement.effect == "Allow" || (
        statement.sid == "NoDeploymentOrIdentityAdministration" && statement.resources == toset(["*"]) && length(statement.condition) == 0 &&
        statement.actions == toset(["cloudformation:*", "sts:*", "account:*", "organizations:*", "iam:DeleteRolePermissionsBoundary", "iam:CreateServiceLinkedRole"])
      )
    ]) && length(data.aws_iam_policy_document.local_cdk_execution_boundary.statement) == 2
    error_message = "The execution boundary denies CloudFormation, STS, account, and organization actions, removing a boundary, and creating service-linked roles."
  }

  # The boundary allows every identity grant, so it caps the role at exactly
  # those services.
  assert {
    condition = alltrue(flatten([
      for statement in concat(
        data.aws_iam_policy_document.local_cdk_execution.statement,
        data.aws_iam_policy_document.local_cdk_execution_compute.statement,
        data.aws_iam_policy_document.local_cdk_execution_events.statement,
        ) : [
        for action in statement.actions :
        anytrue([for boundary in data.aws_iam_policy_document.local_cdk_execution_boundary.statement : boundary.effect == "Allow" && anytrue([for pattern in boundary.actions : can(regex("(?i)^${replace(pattern, "*", ".*")}$", action))])]) &&
        !anytrue([for boundary in data.aws_iam_policy_document.local_cdk_execution_boundary.statement : boundary.effect == "Deny" && anytrue([for pattern in boundary.actions : can(regex("(?i)^${replace(pattern, "*", ".*")}$", action))])])
      ] if statement.effect == "Allow"
    ]))
    error_message = "The execution boundary must allow every action the identity policies grant."
  }
}

# Runtime boundary: the cap on every role an ephemeral stack creates.
run "runtime_boundary_denies_deployment_and_shared_data" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment               = "dev"
    create_local_cdk_policies = true
  }

  assert {
    condition = jsonencode({
      for statement in data.aws_iam_policy_document.local_cdk_workload_boundary.statement : statement.sid => {
        actions    = sort(statement.actions)
        resources  = sort(statement.resources)
        conditions = sort([for condition in statement.condition : "${condition.test} ${condition.variable} ${join(",", condition.values)}"])
      } if statement.effect == "Deny"
      }) == jsonencode({
      NoDeploymentOrIdentityAdministration = {
        actions    = sort(["iam:*", "sts:*", "cloudformation:*", "account:*", "organizations:*"])
        resources  = ["*"]
        conditions = []
      }
      EphemeralPrefixesAtKeyRoot = {
        actions    = ["s3:*"]
        resources  = sort(["arn:aws:s3:::*/*/ephemeral/*", "arn:aws:s3:::*/*/incoming/*"])
        conditions = []
      }
      OnlyThisAccountsBuckets = {
        actions    = ["s3:*"]
        resources  = ["*"]
        conditions = sort(["StringNotEquals s3:ResourceAccount $${aws:PrincipalAccount}", "Null s3:ResourceAccount false"])
      }
      ProtectSharedInboundEmail = {
        actions    = ["s3:*"]
        resources  = ["arn:aws:s3:::*/incoming/dev/*"]
        conditions = []
      }
      ProtectStableBootstrapAssets = {
        actions    = sort(["s3:*", "ecr:*"])
        resources  = sort(["arn:aws:s3:::cdk-hnb659fds-*", "arn:aws:s3:::cdk-hnb659fds-*/*", "arn:aws:ecr:us-east-1:000000000000:repository/cdk-hnb659fds-*"])
        conditions = []
      }
    })
    error_message = "The runtime boundary denies identity and deployment administration, ephemeral prefixes below the key root, other accounts' buckets, shared inbound email, and the stable bootstrap assets."
  }

  # Denies stay name-free, so they never need a list of shared resources.
  assert {
    condition = alltrue(flatten([
      for statement in concat(
        data.aws_iam_policy_document.local_cdk_workload_boundary.statement,
        data.aws_iam_policy_document.local_cdk_execution_boundary.statement,
      ) : [for resource in statement.resources : !strcontains(resource, "-dev")] if statement.effect == "Deny"
    ]))
    error_message = "No deny names shared dev resources."
  }
}

run "runtime_boundary_reaches_only_its_own_ephemeral_data" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment               = "dev"
    create_local_cdk_policies = true
  }

  assert {
    condition = jsonencode({
      for statement in data.aws_iam_policy_document.local_cdk_workload_boundary.statement : statement.sid => {
        actions    = sort(statement.actions)
        resources  = sort(statement.resources)
        conditions = sort([for condition in statement.condition : "${condition.test} ${condition.variable} ${join(",", condition.values)}"])
      } if statement.effect == "Allow" && anytrue([for action in statement.actions : startswith(action, "s3:")])
      }) == jsonencode({
      WriteEphemeralObjects = {
        actions    = ["s3:PutObject"]
        resources  = ["arn:aws:s3:::*/ephemeral/$${aws:PrincipalTag/Ephemeral}/*"]
        conditions = []
      }
      ReadEphemeralObjects = {
        actions    = ["s3:GetObject*"]
        resources  = sort(["arn:aws:s3:::*/ephemeral/$${aws:PrincipalTag/Ephemeral}/*", "arn:aws:s3:::*/incoming/$${aws:PrincipalTag/Ephemeral}/*"])
        conditions = []
      }
      ListEphemeralObjects = {
        actions    = ["s3:ListBucket"]
        resources  = ["*"]
        conditions = ["StringLike s3:prefix ephemeral/$${aws:PrincipalTag/Ephemeral}/*"]
      }
    })
    error_message = "Runtime roles write and list only ephemeral/<Ephemeral tag>/, and read only that prefix and incoming/<Ephemeral tag>/."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.local_cdk_workload_boundary.statement :
      statement.sid == "ReadApplicationParameters" && statement.actions == toset(["ssm:GetParameter"]) && statement.resources == toset(["arn:aws:ssm:us-east-1:000000000000:parameter/mcc/dev/*"])
      if anytrue([for action in statement.actions : startswith(action, "ssm:")])
    ])
    error_message = "Runtime roles read single /mcc/dev/* parameters and nothing else in SSM; the one ARN keeps the boundary the same size as applications are added."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.local_cdk_workload_boundary.statement :
      toset([for condition in statement.condition : "${condition.test} ${condition.variable} ${join(",", condition.values)}"]) == toset(["StringEquals kms:ViaService s3.us-east-1.amazonaws.com"])
      if statement.effect == "Allow" && anytrue([for action in statement.actions : startswith(action, "kms:") && action != "kms:DescribeKey"])
    ])
    error_message = "Runtime roles use KMS keys only through S3."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.local_cdk_workload_boundary.statement :
      statement.sid == "WriteEphemeralLogs" ? alltrue([for resource in statement.resources : can(regex("^arn:aws:logs:us-east-1:000000000000:log-group:/aws/\\*/(admin|data-pipeline|match-to-csv|ocr-quality|player)-e-\\*$", resource))]) : (
        statement.sid == "UseEphemeralCompute" ? (
          statement.actions == toset(["lambda:InvokeFunction", "states:StartExecution", "states:DescribeExecution", "states:StopExecution", "states:GetExecutionHistory", "sqs:SendMessage"]) &&
          alltrue([for resource in statement.resources : can(regex("^arn:aws:(lambda:us-east-1:000000000000:function:|states:us-east-1:000000000000:(stateMachine|execution):|sqs:us-east-1:000000000000:|logs:us-east-1:000000000000:log-group:/aws/\\*/)(admin|data-pipeline|match-to-csv|ocr-quality|player)-e-\\*$", resource))])
        ) : true
      )
    ])
    error_message = "Runtime roles write only ephemeral log groups and invoke, start, or message only ephemeral compute."
  }

  assert {
    condition = alltrue(flatten([
      for statement in data.aws_iam_policy_document.local_cdk_workload_boundary.statement : [
        for action in statement.actions : [
          for forbidden in ["lambda:CreateFunction", "lambda:UpdateFunctionCode", "states:UpdateStateMachine", "iam:PutRolePolicy", "iam:PassRole", "sts:AssumeRole", "cloudformation:UpdateStack", "ssm:PutParameter", "ssm:GetParametersByPath"] :
          !can(regex("(?i)^${replace(action, "*", ".*")}$", forbidden))
        ]
      ] if statement.effect == "Allow"
    ]))
    error_message = "Runtime roles cannot change compute, roles, stacks, or parameters, or assume another role."
  }
}
