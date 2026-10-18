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

# scripts/deployment-workflows.test.mjs checks that the default path is the
# reusable workflow every top-level delivery workflow calls.
run "cdk_role_trusts_the_reusable_deploy_workflow" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment              = "dev"
    github_organization      = "example"
    github_oidc_provider_arn = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com"
  }
  # Each entry is "<test> <claim> <values>" for one trust condition.
  assert {
    condition = toset([
      for condition in one(data.aws_iam_policy_document.cdk_deploy_assume_role[0].statement).condition :
      "${condition.test} ${trimprefix(condition.variable, "token.actions.githubusercontent.com:")} ${join(",", condition.values)}"
      if condition.variable != "token.actions.githubusercontent.com:job_workflow_ref"
      ]) == toset([
      "StringEquals aud sts.amazonaws.com",
      "StringEquals sub repo:example/mcc-stats-suite:environment:dev",
      "StringEquals repository example/mcc-stats-suite",
      "StringEquals ref refs/heads/main",
    ])
    error_message = "The CDK entry role must keep its aud, sub, repository, and ref conditions and check no workflow name."
  }
  assert {
    condition = [
      for condition in one(data.aws_iam_policy_document.cdk_deploy_assume_role[0].statement).condition :
      "${condition.test} ${join(",", condition.values)}"
      if condition.variable == "token.actions.githubusercontent.com:job_workflow_ref"
      ] == [
      "StringEquals example/mcc-stats-suite/.github/workflows/_delivery-deploy-environment.yml@refs/heads/main",
    ]
    error_message = "The CDK entry role must trust exactly the reusable deploy workflow on main."
  }
}

# job_workflow_ref always uses owner/repo, even when OIDC subjects are immutable.
run "cdk_role_workflow_ref_ignores_the_subject_repository" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment                    = "prod"
    github_organization            = "example"
    github_oidc_subject_repository = "example@1/mcc-stats-suite@2"
    github_deployment_branch       = "release"
    cdk_deploy_workflow_path       = ".github/workflows/_deploy.yaml"
    github_oidc_provider_arn       = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com"
  }
  assert {
    condition = [
      for condition in one(data.aws_iam_policy_document.cdk_deploy_assume_role[0].statement).condition : join(",", condition.values)
      if condition.variable == "token.actions.githubusercontent.com:job_workflow_ref"
    ] == ["example/mcc-stats-suite/.github/workflows/_deploy.yaml@refs/heads/release"]
    error_message = "job_workflow_ref must combine owner/repo, the workflow path, and the deployment branch."
  }
  assert {
    condition = [
      for condition in one(data.aws_iam_policy_document.cdk_deploy_assume_role[0].statement).condition : join(",", condition.values)
      if condition.variable == "token.actions.githubusercontent.com:sub"
    ] == ["repo:example@1/mcc-stats-suite@2:environment:prod"]
    error_message = "sub must still use the subject repository."
  }
}

run "terrateam_role_keeps_its_workflow_ref" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment              = "dev"
    github_organization      = "example"
    github_oidc_provider_arn = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com"
  }
  assert {
    condition = [
      for condition in one(data.aws_iam_policy_document.terrateam_assume_role[0].statement).condition :
      "${condition.test} ${join(",", condition.values)}"
      if condition.variable == "token.actions.githubusercontent.com:job_workflow_ref"
      ] == [
      "StringLike example/mcc-stats-suite/.github/workflows/terrateam.yml@*",
    ]
    error_message = "The Terrateam role must keep trusting its workflow at any ref."
  }
}

run "cdk_role_requires_a_workflow_path" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment              = "dev"
    github_organization      = "example"
    github_oidc_provider_arn = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com"
    cdk_deploy_workflow_path = ""
  }
  expect_failures = [var.cdk_deploy_workflow_path]
}

run "cdk_role_rejects_a_path_outside_the_workflows_directory" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment              = "dev"
    github_organization      = "example"
    github_oidc_provider_arn = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com"
    cdk_deploy_workflow_path = "./.github/workflows/_delivery-deploy-environment.yml"
  }
  expect_failures = [var.cdk_deploy_workflow_path]
}

run "cdk_role_rejects_a_path_with_spaces" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment              = "dev"
    github_organization      = "example"
    github_oidc_provider_arn = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com"
    cdk_deploy_workflow_path = ".github/workflows/ .yml"
  }
  expect_failures = [var.cdk_deploy_workflow_path]
}
