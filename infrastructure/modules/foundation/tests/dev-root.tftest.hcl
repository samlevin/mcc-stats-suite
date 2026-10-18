# Plans the dev foundation root itself, not only the module, as on a fresh
# account where no foundation resource exists yet. Every file in the root takes
# part, so a root-level import block, which needs its resource to exist, fails
# this plan. The module suites set a module source and never plan the root's
# own files. A root run can assert only on module outputs, and module-scoped
# file-level overrides would break it, so root runs live in this file.
# Fake credentials and overrides prevent AWS calls.
provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_region_validation      = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
}

run "dev_root_plans_on_a_fresh_account" {
  command = plan
  plan_options { refresh = false }
  variables {
    email_alias                    = "submit"
    email_domain                   = "mail.example.com"
    github_oidc_subject_repository = "example-owner/example-repo"
  }

  override_data {
    target = module.foundation.data.aws_caller_identity.current
    values = { account_id = "000000000000" }
  }

  override_data {
    target = module.foundation.data.aws_partition.current
    values = { partition = "aws", dns_suffix = "amazonaws.com" }
  }

  override_data {
    target = module.foundation.data.aws_region.current
    values = { region = "us-east-1" }
  }

  override_resource {
    target = module.foundation.aws_kms_key.data
    values = { arn = "arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000000" }
  }

  // A fresh account has no published parameters yet.
  override_data {
    target = module.foundation.data.aws_ssm_parameters_by_path.match_to_csv
    values = { names = [], values = [] }
  }

  assert {
    condition     = module.foundation.receipt_rule_set_name == "mcc-inbound-dev"
    error_message = "The dev foundation root must create the dev receipt rule set."
  }

  assert {
    condition     = module.foundation.github_turbo_cache_role_arn == "arn:aws:iam::000000000000:role/mcc-stats-suite-dev-github-turbo-cache"
    error_message = "The dev foundation root must create the dev GitHub Turbo cache role."
  }
}
