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

# scripts/deployment-workflows.test.mjs checks the current callers' names and
# the two names no workflow uses.
run "cdk_role_trusts_every_deployment_caller" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment              = "dev"
    github_organization      = "example"
    github_oidc_provider_arn = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com"
  }
  assert {
    condition = toset(one([
      for condition in one(data.aws_iam_policy_document.cdk_deploy_assume_role[0].statement).condition : condition
      if condition.variable == "token.actions.githubusercontent.com:workflow"
      ]).values) == toset([
      "deploy-applications",
      "rollback-aws-application",
      "Delivery: deploy to dev then prod",
      "Delivery: roll back prod",
    ])
    error_message = "The CDK entry role must trust exactly the current delivery and rollback workflow names and the two unused names."
  }
  assert {
    condition = one([
      for condition in one(data.aws_iam_policy_document.cdk_deploy_assume_role[0].statement).condition : condition
      if condition.variable == "token.actions.githubusercontent.com:workflow"
    ]).test == "StringEquals"
    error_message = "Workflow names must match exactly."
  }
}

run "cdk_role_requires_a_workflow_name" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment              = "dev"
    github_organization      = "example"
    github_oidc_provider_arn = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com"
    cdk_workflow_names       = []
  }
  expect_failures = [var.cdk_workflow_names]
}

run "cdk_role_rejects_a_blank_workflow_name" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment              = "dev"
    github_organization      = "example"
    github_oidc_provider_arn = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com"
    cdk_workflow_names       = ["Delivery: deploy to dev then prod", " "]
  }
  expect_failures = [var.cdk_workflow_names]
}
