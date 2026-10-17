# The local CDK policy names and applications must agree with the bootstrap
# grant, the bootstrap template, and cdk-config. The last two are outside
# OpenTofu, so this suite reads them: CI runs it for a change to any of these
# files. Paths in file() are relative to infrastructure/dev/foundation, the
# root scripts/tofu-checks.sh runs these tests through.
provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_region_validation      = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
}

# Both modules read these data sources.
override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "000000000000" }
}

override_data {
  target = data.aws_partition.current
  values = { partition = "aws", dns_suffix = "amazonaws.com" }
}

run "names_match_the_bootstrap_template_and_cdk_config" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment               = "dev"
    create_local_cdk_policies = true
    email_alias               = "example-alias"
    email_domain              = "mail.example.com"
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
      names  = ["/mcc/dev/match-to-csv/email-alias"]
      values = ["example-alias"]
    }
  }

  # The same list as the bootstrap run below, so renaming a policy in one
  # module fails until the other matches.
  assert {
    condition = toset([for policy in aws_iam_policy.local_cdk : policy.name]) == toset([
      "mcc-stats-suite-local-workload-boundary",
      "mcc-stats-suite-local-cdk-execution-boundary",
      "mcc-stats-suite-local-cdk-execution",
      "mcc-stats-suite-local-cdk-execution-compute",
      "mcc-stats-suite-local-cdk-execution-events",
    ])
    error_message = "The foundation creates exactly the policies the bootstrap grant names."
  }

  assert {
    condition = toset([
      for match in regexall("'([^']+)'", regex("export const APPLICATIONS = \\[([^\\]]*)\\]", file("../../../scripts/cdk-targets.mjs"))[0]) : match[0]
      ]) == toset([
      for resource in one([for statement in data.aws_iam_policy_document.local_cdk_execution_compute.statement : statement if statement.sid == "ManageEphemeralCompute"]).resources :
      regex(":function:(.+)-e-\\*$", resource)[0] if strcontains(resource, ":function:")
    ])
    error_message = "The policies cover exactly the APPLICATIONS in scripts/cdk-targets.mjs."
  }

  assert {
    condition = alltrue([
      for key in ["execution_boundary", "execution", "execution_compute", "execution_events"] :
      strcontains(file("../../../scripts/local-cdk-bootstrap.mjs"), "'${aws_iam_policy.local_cdk[key].name}'")
    ])
    error_message = "scripts/local-cdk-bootstrap.mjs must attach the execution policies and boundary by these names."
  }

  assert {
    condition     = strcontains(file("../../../packages/cdk-config/src/index.ts"), "'${aws_iam_policy.local_cdk["workload_boundary"].name}'")
    error_message = "packages/cdk-config must give ephemeral roles the workload boundary by this name."
  }
}

run "bootstrap_grant_covers_exactly_these_policies" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/bootstrap" }
  variables {
    environment               = "dev"
    github_organization       = "example"
    manage_local_cdk_policies = true
  }

  assert {
    condition = toset([
      for resource in one(data.aws_iam_policy_document.terrateam_local_cdk_policy_management.statement).resources :
      trimprefix(resource, "arn:aws:iam::000000000000:policy/")
      ]) == toset([
      "mcc-stats-suite-local-workload-boundary",
      "mcc-stats-suite-local-cdk-execution-boundary",
      "mcc-stats-suite-local-cdk-execution",
      "mcc-stats-suite-local-cdk-execution-compute",
      "mcc-stats-suite-local-cdk-execution-events",
    ])
    error_message = "The dev Terrateam role may manage exactly the policies the foundation creates."
  }
}
