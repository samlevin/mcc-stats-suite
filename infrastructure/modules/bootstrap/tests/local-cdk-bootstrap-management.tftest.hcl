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

run "dev_grant_manages_the_local_cdk_bootstrap_stack" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment                = "dev"
    github_organization        = "example"
    manage_local_cdk_bootstrap = true
  }
  assert {
    condition     = length(aws_iam_role_policy.terrateam_local_cdk_bootstrap_management) == 1
    error_message = "With manage_local_cdk_bootstrap on, the Terrateam role gets the local CDK bootstrap grant."
  }
  assert {
    condition     = aws_iam_role_policy.terrateam_local_cdk_bootstrap_management[0].name == "manage-local-cdk-bootstrap"
    error_message = "The grant keeps its own inline policy name, separate from the cache-role grant."
  }
  assert {
    condition = length(data.aws_iam_policy_document.terrateam_local_cdk_bootstrap_management.statement) == 5 && alltrue([
      for statement in data.aws_iam_policy_document.terrateam_local_cdk_bootstrap_management.statement :
      statement.effect == "Allow" && try(length(statement.not_actions), 0) == 0 && try(length(statement.not_resources), 0) == 0
    ])
    error_message = "The grant has exactly five Allow statements, with no NotAction or NotResource."
  }
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.terrateam_local_cdk_bootstrap_management.statement :
      statement.actions == toset(["cloudformation:*"]) && length(statement.condition) == 0 &&
      statement.resources == toset(["arn:aws:cloudformation:*:000000000000:stack/CDKToolkitLocal/*"])
      if statement.sid == "ManageLocalToolkitStack"
    ])
    error_message = "CloudFormation actions, including change sets and the stack policy, apply only to the CDKToolkitLocal stack."
  }
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.terrateam_local_cdk_bootstrap_management.statement :
      length(statement.condition) == 0 &&
      statement.resources == toset(["arn:aws:iam::000000000000:role/cdk-mcclocal1-*"]) &&
      statement.actions == toset([
        "iam:CreateRole", "iam:GetRole", "iam:DeleteRole", "iam:UpdateRole",
        "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy",
        "iam:TagRole", "iam:UntagRole", "iam:ListRoleTags",
        "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:PutRolePolicy",
        "iam:DeleteRolePolicy", "iam:ListAttachedRolePolicies",
        "iam:DetachRolePolicy", "iam:ListInstanceProfilesForRole",
      ])
      if statement.sid == "ManageLocalBootstrapRoles"
    ])
    error_message = "Role lifecycle, tag, inline policy, and detach actions apply only to cdk-mcclocal1-* roles."
  }
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.terrateam_local_cdk_bootstrap_management.statement :
      statement.resources == toset(["arn:aws:iam::000000000000:role/cdk-mcclocal1-*"]) &&
      length(statement.condition) == 1 && one(statement.condition).test == "ArnLike" &&
      toset(one(statement.condition).values) == toset(["arn:aws:iam::000000000000:policy/mcc-stats-suite-local-*"]) &&
      (
        statement.sid == "AttachOnlyLocalPolicies" ?
        statement.actions == toset(["iam:AttachRolePolicy"]) && one(statement.condition).variable == "iam:PolicyARN" :
        statement.actions == toset(["iam:PutRolePermissionsBoundary"]) && one(statement.condition).variable == "iam:PermissionsBoundary"
      )
      if contains(["AttachOnlyLocalPolicies", "SetOnlyLocalBoundaries"], statement.sid)
    ])
    error_message = "AttachRolePolicy and PutRolePermissionsBoundary on cdk-mcclocal1-* roles accept only mcc-stats-suite-local-* policies."
  }
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.terrateam_local_cdk_bootstrap_management.statement :
      length(statement.condition) == 0 &&
      statement.resources == toset(["arn:aws:iam::000000000000:policy/mcc-stats-suite-local-*"]) &&
      statement.actions == toset([
        "iam:CreatePolicy", "iam:GetPolicy", "iam:DeletePolicy",
        "iam:CreatePolicyVersion", "iam:GetPolicyVersion", "iam:ListPolicyVersions",
        "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion",
        "iam:TagPolicy", "iam:UntagPolicy", "iam:ListPolicyTags",
        "iam:ListEntitiesForPolicy",
      ])
      if statement.sid == "ManageLocalPolicies"
    ])
    error_message = "Managed policy lifecycle and tag actions apply only to mcc-stats-suite-local-* policies."
  }
  assert {
    condition = toset([
      for statement in data.aws_iam_policy_document.terrateam_local_cdk_bootstrap_management.statement : statement.sid
    ]) == toset(["ManageLocalToolkitStack", "ManageLocalBootstrapRoles", "AttachOnlyLocalPolicies", "SetOnlyLocalBoundaries", "ManageLocalPolicies"])
    error_message = "Each statement checked above is present once."
  }
}

run "no_iam_statement_uses_a_wildcard_resource" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment                = "dev"
    github_organization        = "example"
    manage_local_cdk_bootstrap = true
  }
  assert {
    condition = alltrue(flatten([
      for statement in data.aws_iam_policy_document.terrateam_local_cdk_bootstrap_management.statement : [
        for resource in statement.resources :
        resource != "*" && (
          startswith(resource, "arn:aws:iam::000000000000:role/cdk-mcclocal1-") ||
          startswith(resource, "arn:aws:iam::000000000000:policy/mcc-stats-suite-local-")
        )
      ] if anytrue([for action in statement.actions : startswith(action, "iam:")])
    ]))
    error_message = "Every IAM resource in the grant is a cdk-mcclocal1-* role or an mcc-stats-suite-local-* policy, never *."
  }
  assert {
    condition = alltrue(flatten([
      for statement in data.aws_iam_policy_document.terrateam_local_cdk_bootstrap_management.statement : [
        for action in statement.actions : !strcontains(action, "*")
      ] if anytrue([for action in statement.actions : startswith(action, "iam:")])
    ]))
    error_message = "IAM actions are listed by name, never by wildcard."
  }
}

run "grant_is_off_by_default" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment         = "dev"
    github_organization = "example"
  }
  assert {
    condition     = length(aws_iam_role_policy.terrateam_local_cdk_bootstrap_management) == 0
    error_message = "Without manage_local_cdk_bootstrap, the Terrateam role gets no local CDK bootstrap grant."
  }
  assert {
    condition     = length(aws_iam_role_policy.terrateam_cache_role_management) == 1
    error_message = "The cache-role grant does not depend on manage_local_cdk_bootstrap."
  }
}

run "prod_has_no_grant" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment         = "prod"
    github_organization = "example"
  }
  assert {
    condition     = length(aws_iam_role_policy.terrateam_local_cdk_bootstrap_management) == 0
    error_message = "The prod Terrateam role never gets the local CDK bootstrap grant."
  }
}

run "prod_rejects_the_grant" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment                = "prod"
    github_organization        = "example"
    manage_local_cdk_bootstrap = true
  }
  expect_failures = [var.manage_local_cdk_bootstrap]
}

run "no_grant_without_a_terrateam_role" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment                = "dev"
    github_organization        = "example"
    create_terrateam_role      = false
    manage_local_cdk_bootstrap = true
  }
  assert {
    condition     = length(aws_iam_role_policy.terrateam_local_cdk_bootstrap_management) == 0
    error_message = "Without a Terrateam role there is no role to grant."
  }
}
