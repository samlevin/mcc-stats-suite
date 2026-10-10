# Only local plans run. Fake credentials and overrides prevent AWS calls while
# the real provider validates resource arguments.
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

variables {
  email_domain = "mail.example.com"
}

run "dev_shared_rule" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables { environment = "dev" }

  assert {
    condition = (
      aws_ses_receipt_rule_set.inbound.rule_set_name == "mcc-match-to-csv-dev" &&
      aws_ses_active_receipt_rule_set.inbound.rule_set_name == "mcc-match-to-csv-dev" &&
      aws_ses_receipt_rule.store_raw_email.name == "match-to-csv-dev" &&
      aws_ses_receipt_rule.store_raw_email.rule_set_name == "mcc-match-to-csv-dev"
    )
    error_message = "The rule set, activation, and shared rule must keep the names CDK used so existing installs import them."
  }

  assert {
    condition = (
      length(aws_ses_receipt_rule.store_raw_email.recipients) == 1 &&
      contains(aws_ses_receipt_rule.store_raw_email.recipients, "submit@mail.example.com")
    )
    error_message = "The shared rule must accept only submit@ the configured domain."
  }

  assert {
    condition = (
      one(aws_ses_receipt_rule.store_raw_email.s3_action).object_key_prefix == "incoming/dev/" &&
      one(aws_ses_receipt_rule.store_raw_email.stop_action).scope == "RuleSet"
    )
    error_message = "The shared rule must store mail under incoming/<environment>/ and stop rule-set processing."
  }

  assert {
    condition = (
      aws_ssm_parameter.receipt_rule_set_name.name == "/mcc/dev/match-to-csv/receipt-rule-set-name" &&
      aws_ssm_parameter.receipt_rule_set_name.value == "mcc-match-to-csv-dev" &&
      aws_ssm_parameter.email_domain.name == "/mcc/dev/match-to-csv/email-domain" &&
      aws_ssm_parameter.email_domain.value == "mail.example.com"
    )
    error_message = "The rule set name and the domain must be published in SSM for CDK and the deployment workflow."
  }
}

run "prod_shared_rule" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables { environment = "prod" }

  assert {
    condition = (
      aws_ses_receipt_rule_set.inbound.rule_set_name == "mcc-match-to-csv-prod" &&
      one(aws_ses_receipt_rule.store_raw_email.s3_action).object_key_prefix == "incoming/prod/" &&
      aws_ssm_parameter.receipt_rule_set_name.name == "/mcc/prod/match-to-csv/receipt-rule-set-name" &&
      aws_ssm_parameter.email_domain.name == "/mcc/prod/match-to-csv/email-domain"
    )
    error_message = "Prod must use its own rule set, prefix, and SSM parameters."
  }
}

run "reject_non_domain" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment  = "dev"
    email_domain = "submit@mail.example.com"
  }
  expect_failures = [var.email_domain]
}
