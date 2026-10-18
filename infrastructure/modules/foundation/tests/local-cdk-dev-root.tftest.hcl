# Plans the dev foundation root, not the module, as on a fresh account where
# none of the local CDK policies exist. The local bootstrap needs them, so the
# root must create them. Fake credentials and overrides prevent AWS calls.
provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_region_validation      = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
}

run "dev_root_creates_the_policies_on_a_fresh_account" {
  command = plan
  plan_options { refresh = false }
  variables {
    email_alias  = "example-alias"
    email_domain = "mail.example.com"
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

  override_data {
    target = module.foundation.data.aws_ssm_parameters_by_path.match_to_csv
    values = {
      names  = ["/mcc/dev/match-to-csv/email-alias"]
      values = ["example-alias"]
    }
  }

  assert {
    condition     = length(module.foundation.local_cdk_policy_names) == 5
    error_message = "A plan of infrastructure/dev/foundation on a fresh account must create the five local CDK policies."
  }
}
