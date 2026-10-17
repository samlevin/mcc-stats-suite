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

run "dev_grant_manages_only_the_local_cdk_policies" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment               = "dev"
    github_organization       = "example"
    manage_local_cdk_policies = true
  }
  assert {
    condition     = length(aws_iam_role_policy.terrateam_local_cdk_policy_management) == 1
    error_message = "With manage_local_cdk_policies on, the Terrateam role gets the local CDK policy grant."
  }
  assert {
    condition     = aws_iam_role_policy.terrateam_local_cdk_policy_management[0].name == "manage-local-cdk-policies"
    error_message = "The grant keeps its own inline policy name, separate from the cache-role grant."
  }
  assert {
    condition = length(data.aws_iam_policy_document.terrateam_local_cdk_policy_management.statement) == 1 && alltrue([for statement in data.aws_iam_policy_document.terrateam_local_cdk_policy_management.statement :
      statement.sid == "ManageOnlyLocalCdkPolicies" && statement.effect == "Allow" && length(statement.condition) == 0 &&
      try(length(statement.not_actions), 0) == 0 && try(length(statement.not_resources), 0) == 0 &&
      statement.resources == toset([
        "arn:aws:iam::000000000000:policy/mcc-stats-suite-local-workload-boundary",
        "arn:aws:iam::000000000000:policy/mcc-stats-suite-local-cdk-execution-boundary",
        "arn:aws:iam::000000000000:policy/mcc-stats-suite-local-cdk-execution",
        "arn:aws:iam::000000000000:policy/mcc-stats-suite-local-cdk-execution-compute",
        "arn:aws:iam::000000000000:policy/mcc-stats-suite-local-cdk-execution-events",
      ]) &&
      statement.actions == toset(["iam:CreatePolicy", "iam:GetPolicy", "iam:DeletePolicy", "iam:CreatePolicyVersion", "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:DeletePolicyVersion", "iam:TagPolicy", "iam:UntagPolicy", "iam:ListPolicyTags"])
    ])
    error_message = "Terrateam may manage only the five local CDK policies, by exact ARN, and only through IAM policy lifecycle actions."
  }
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.terrateam_local_cdk_policy_management.statement :
      alltrue([for action in statement.actions : !can(regex("^iam:(Attach|Detach|Put|Delete)(Role|User|Group)", action)) && !strcontains(action, "*")])
    ])
    error_message = "The grant never attaches or detaches policies, changes boundaries, or uses wildcard actions."
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
    condition     = length(aws_iam_role_policy.terrateam_local_cdk_policy_management) == 0
    error_message = "Without manage_local_cdk_policies, the Terrateam role gets no local CDK policy grant."
  }
  assert {
    condition     = length(aws_iam_role_policy.terrateam_cache_role_management) == 1
    error_message = "The cache-role grant does not depend on manage_local_cdk_policies."
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
    condition     = length(aws_iam_role_policy.terrateam_local_cdk_policy_management) == 0
    error_message = "The prod Terrateam role never gets the local CDK policy grant."
  }
}

run "prod_rejects_the_grant" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment               = "prod"
    github_organization       = "example"
    manage_local_cdk_policies = true
  }
  expect_failures = [var.manage_local_cdk_policies]
}

run "no_grant_without_a_terrateam_role" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment               = "dev"
    github_organization       = "example"
    create_terrateam_role     = false
    manage_local_cdk_policies = true
  }
  assert {
    condition     = length(aws_iam_role_policy.terrateam_local_cdk_policy_management) == 0
    error_message = "Without a Terrateam role there is no role to grant."
  }
}
