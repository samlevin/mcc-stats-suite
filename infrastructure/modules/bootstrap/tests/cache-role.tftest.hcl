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
override_resource {
  target = aws_iam_policy.workload_boundary
  values = { arn = "arn:aws:iam::000000000000:policy/mcc-stats-suite-workload-boundary" }
}

run "dev_scoped_cache_role_management" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment         = "dev"
    github_organization = "example"
  }
  assert {
    condition = length(data.aws_iam_policy_document.terrateam_cache_role_management.statement) == 2 && alltrue([for statement in data.aws_iam_policy_document.terrateam_cache_role_management.statement :
      statement.effect == "Allow" && statement.resources == toset(["arn:aws:iam::000000000000:role/mcc-stats-suite-dev-github-turbo-cache"]) &&
      (statement.sid == "CreateBoundedCacheRole" ? statement.actions == toset(["iam:CreateRole"]) && one(statement.condition).variable == "iam:PermissionsBoundary" && toset(one(statement.condition).values) == toset(["arn:aws:iam::000000000000:policy/mcc-stats-suite-workload-boundary"]) :
      statement.sid == "ManageOnlyCacheRole" && length(statement.condition) == 0 && statement.actions == toset(["iam:GetRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:ListAttachedRolePolicies", "iam:TagRole", "iam:UntagRole", "iam:ListRoleTags", "iam:ListInstanceProfilesForRole"]))
    ])
    error_message = "Terrateam may manage only this environment's cache role, must supply the boundary at creation, and cannot remove boundaries or attach other policies."
  }
  assert {
    condition = alltrue([
      for action in ["iam:GetRole", "iam:ListInstanceProfilesForRole", "iam:DeleteRole"] :
      contains(one([
        for statement in data.aws_iam_policy_document.terrateam_cache_role_management.statement : statement
        if statement.sid == "ManageOnlyCacheRole"
      ]).actions, action)
    ])
    error_message = "AWS provider role deletion always lists instance profiles, even for cache roles with no profiles; lifecycle permissions must cover that lookup and deletion."
  }
}

run "prod_scoped_cache_role_management" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment         = "prod"
    github_organization = "example"
  }
  assert {
    condition = length(data.aws_iam_policy_document.terrateam_cache_role_management.statement) == 2 && alltrue([for statement in data.aws_iam_policy_document.terrateam_cache_role_management.statement :
      statement.effect == "Allow" && statement.resources == toset(["arn:aws:iam::000000000000:role/mcc-stats-suite-prod-github-turbo-cache"]) &&
      (statement.sid == "CreateBoundedCacheRole" ? statement.actions == toset(["iam:CreateRole"]) && one(statement.condition).variable == "iam:PermissionsBoundary" && toset(one(statement.condition).values) == toset(["arn:aws:iam::000000000000:policy/mcc-stats-suite-workload-boundary"]) :
      statement.sid == "ManageOnlyCacheRole" && length(statement.condition) == 0 && statement.actions == toset(["iam:GetRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:ListAttachedRolePolicies", "iam:TagRole", "iam:UntagRole", "iam:ListRoleTags", "iam:ListInstanceProfilesForRole"]))
    ])
    error_message = "Terrateam may manage only this environment's cache role, must supply the boundary at creation, and cannot remove boundaries or attach other policies."
  }
  assert {
    condition = alltrue([
      for action in ["iam:GetRole", "iam:ListInstanceProfilesForRole", "iam:DeleteRole"] :
      contains(one([
        for statement in data.aws_iam_policy_document.terrateam_cache_role_management.statement : statement
        if statement.sid == "ManageOnlyCacheRole"
      ]).actions, action)
    ])
    error_message = "AWS provider role deletion always lists instance profiles, even for cache roles with no profiles; lifecycle permissions must cover that lookup and deletion."
  }
}
