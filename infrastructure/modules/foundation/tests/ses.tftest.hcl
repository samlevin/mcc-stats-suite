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

// The published alias matches the configured one unless a run overrides it.
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

run "dev_shared_rule" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables { environment = "dev" }

  assert {
    condition = (
      aws_ses_receipt_rule_set.inbound.rule_set_name == "mcc-inbound-dev" &&
      aws_ses_active_receipt_rule_set.inbound.rule_set_name == "mcc-inbound-dev" &&
      aws_ses_receipt_rule.store_raw_email.name == "submit" &&
      aws_ses_receipt_rule.store_raw_email.rule_set_name == "mcc-inbound-dev"
    )
    error_message = "The rule set, activation, and submit rule must use the foundation names."
  }

  assert {
    condition = (
      length(aws_ses_receipt_rule.store_raw_email.recipients) == 1 &&
      contains(aws_ses_receipt_rule.store_raw_email.recipients, "example-alias@mail.example.com")
    )
    error_message = "The shared rule must accept only the configured alias at the configured domain."
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
      aws_ssm_parameter.receipt_rule_set_name.value == "mcc-inbound-dev" &&
      aws_ssm_parameter.email_domain.name == "/mcc/dev/match-to-csv/email-domain" &&
      aws_ssm_parameter.email_domain.value == "mail.example.com" &&
      aws_ssm_parameter.email_alias.name == "/mcc/dev/match-to-csv/email-alias" &&
      aws_ssm_parameter.email_alias.value == "example-alias"
    )
    error_message = "The rule set name, the alias, and the domain must be published in SSM."
  }

  assert {
    condition = (
      issensitive(var.email_domain) &&
      issensitive(var.email_alias) &&
      issensitive(aws_ses_receipt_rule.store_raw_email.recipients) &&
      issensitive(aws_ssm_parameter.email_domain.value) &&
      issensitive(aws_ssm_parameter.email_alias.value)
    )
    error_message = "The alias and the domain must stay sensitive so Terrateam plan comments and drift issues redact the recipients."
  }
}

run "prod_shared_rule" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables { environment = "prod" }

  assert {
    condition = (
      aws_ses_receipt_rule_set.inbound.rule_set_name == "mcc-inbound-prod" &&
      one(aws_ses_receipt_rule.store_raw_email.s3_action).object_key_prefix == "incoming/prod/" &&
      aws_ssm_parameter.receipt_rule_set_name.name == "/mcc/prod/match-to-csv/receipt-rule-set-name" &&
      aws_ssm_parameter.email_domain.name == "/mcc/prod/match-to-csv/email-domain" &&
      aws_ssm_parameter.email_alias.name == "/mcc/prod/match-to-csv/email-alias"
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
    email_domain = "example-alias@mail.example.com"
  }
  expect_failures = [var.email_domain]
}

run "reject_uppercase_domain" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment  = "dev"
    email_domain = "Mail.Example.com"
  }
  expect_failures = [var.email_domain]
}

run "accept_dotted_alias" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment = "dev"
    email_alias = "example.alias_1-x"
  }
  override_data {
    target = data.aws_ssm_parameters_by_path.match_to_csv
    values = {
      names  = ["/mcc/dev/match-to-csv/email-alias"]
      values = ["example.alias_1-x"]
    }
  }

  assert {
    condition     = contains(aws_ses_receipt_rule.store_raw_email.recipients, "example.alias_1-x@mail.example.com")
    error_message = "Dots between parts, digits, underscores, and hyphens are valid in the alias."
  }
}

// Ephemeral addresses append +<name>, so a + in the alias would be ambiguous.
run "reject_plus_alias" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment = "dev"
    email_alias = "example-alias+tag"
  }
  expect_failures = [var.email_alias]
}

run "reject_uppercase_alias" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment = "dev"
    email_alias = "Example-Alias"
  }
  expect_failures = [var.email_alias]
}

run "reject_address_alias" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment = "dev"
    email_alias = "example-alias@mail.example.com"
  }
  expect_failures = [var.email_alias]
}

run "reject_empty_alias" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment = "dev"
    email_alias = ""
  }
  expect_failures = [var.email_alias]
}

run "reject_misplaced_dots_alias" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment = "dev"
    email_alias = ".example..alias"
  }
  expect_failures = [var.email_alias]
}

run "reject_quoted_characters_alias" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment = "dev"
    email_alias = "example alias"
  }
  expect_failures = [var.email_alias]
}

run "reject_long_alias" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment = "dev"
    email_alias = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [var.email_alias]
}

// <alias>+<name> must fit in 64 characters with a 20-character name.
run "accept_longest_alias" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment = "dev"
    email_alias = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  override_data {
    target = data.aws_ssm_parameters_by_path.match_to_csv
    values = {
      names  = ["/mcc/dev/match-to-csv/email-alias"]
      values = ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
    }
  }
}

// Before the first apply publishes the alias, the shared address was submit@.
run "keep_submit_before_first_publish" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment = "dev"
    email_alias = "submit"
  }
  override_data {
    target = data.aws_ssm_parameters_by_path.match_to_csv
    values = { names = [], values = [] }
  }
}

run "warn_when_alias_changes_before_first_publish" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables { environment = "dev" }
  override_data {
    target = data.aws_ssm_parameters_by_path.match_to_csv
    values = { names = [], values = [] }
  }
  expect_failures = [check.shared_address_unchanged]
}

run "warn_when_published_alias_changes" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables { environment = "dev" }
  override_data {
    target = data.aws_ssm_parameters_by_path.match_to_csv
    values = {
      names  = ["/mcc/dev/match-to-csv/email-domain", "/mcc/dev/match-to-csv/email-alias"]
      values = ["mail.example.com", "old-alias"]
    }
  }
  expect_failures = [check.shared_address_unchanged]
}
