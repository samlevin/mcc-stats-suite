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

// The published alias matches the configured one.
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

run "dev_roster_table" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables { environment = "dev" }

  override_resource {
    target = aws_dynamodb_table.roster
    values = { arn = "arn:aws:dynamodb:us-east-1:000000000000:table/mcc-stats-suite-dev-gamertag-roster" }
  }

  assert {
    condition = (
      aws_dynamodb_table.roster.name == "mcc-stats-suite-dev-gamertag-roster" &&
      aws_dynamodb_table.roster.billing_mode == "PAY_PER_REQUEST"
    )
    error_message = "The roster table must be named <project>-<env>-gamertag-roster and use on-demand billing."
  }

  assert {
    condition = (
      aws_dynamodb_table.roster.hash_key == "pk" &&
      aws_dynamodb_table.roster.range_key == "sk" &&
      length(aws_dynamodb_table.roster.attribute) == 2 &&
      alltrue([for attribute in aws_dynamodb_table.roster.attribute : contains(["pk", "sk"], attribute.name) && attribute.type == "S"])
    )
    error_message = "The roster table must have string partition key pk and string sort key sk, and no other attribute."
  }

  assert {
    condition = (
      length(aws_dynamodb_table.roster.global_secondary_index) == 0 &&
      length(aws_dynamodb_table.roster.local_secondary_index) == 0 &&
      !coalesce(aws_dynamodb_table.roster.stream_enabled, false)
    )
    error_message = "The roster table must have no secondary index and no stream."
  }

  assert {
    condition = (
      one(aws_dynamodb_table.roster.server_side_encryption).enabled &&
      one(aws_dynamodb_table.roster.server_side_encryption).kms_key_arn == aws_kms_key.data.arn
    )
    error_message = "The roster table must be encrypted with the foundation application data key."
  }

  assert {
    condition     = one(aws_dynamodb_table.roster.point_in_time_recovery).enabled
    error_message = "The roster table must have point-in-time recovery on."
  }

  assert {
    condition     = aws_dynamodb_table.roster.deletion_protection_enabled
    error_message = "The roster table must have deletion protection on."
  }

  assert {
    condition = (
      aws_ssm_parameter.roster_table_name.name == "/mcc/dev/roster/table-name" &&
      aws_ssm_parameter.roster_table_name.type == "String" &&
      aws_ssm_parameter.roster_table_name.value == "mcc-stats-suite-dev-gamertag-roster" &&
      aws_ssm_parameter.roster_table_arn.name == "/mcc/dev/roster/table-arn" &&
      aws_ssm_parameter.roster_table_arn.type == "String" &&
      aws_ssm_parameter.roster_table_arn.value == "arn:aws:dynamodb:us-east-1:000000000000:table/mcc-stats-suite-dev-gamertag-roster"
    )
    error_message = "The roster table name and ARN must be published under /mcc/<env>/roster/."
  }

  assert {
    condition = (
      output.roster_table_name == aws_dynamodb_table.roster.name &&
      output.roster_table_arn == aws_dynamodb_table.roster.arn
    )
    error_message = "The module must output the roster table name and ARN."
  }
}

run "prod_roster_table" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables { environment = "prod" }

  override_resource {
    target = aws_dynamodb_table.roster
    values = { arn = "arn:aws:dynamodb:us-east-1:000000000000:table/mcc-stats-suite-prod-gamertag-roster" }
  }

  assert {
    condition = (
      aws_dynamodb_table.roster.name == "mcc-stats-suite-prod-gamertag-roster" &&
      aws_dynamodb_table.roster.deletion_protection_enabled &&
      one(aws_dynamodb_table.roster.point_in_time_recovery).enabled &&
      one(aws_dynamodb_table.roster.server_side_encryption).kms_key_arn == aws_kms_key.data.arn
    )
    error_message = "Prod must have its own roster table with the same protection and encryption."
  }

  assert {
    condition = (
      aws_ssm_parameter.roster_table_name.name == "/mcc/prod/roster/table-name" &&
      aws_ssm_parameter.roster_table_name.value == "mcc-stats-suite-prod-gamertag-roster" &&
      aws_ssm_parameter.roster_table_arn.name == "/mcc/prod/roster/table-arn" &&
      aws_ssm_parameter.roster_table_arn.value == "arn:aws:dynamodb:us-east-1:000000000000:table/mcc-stats-suite-prod-gamertag-roster"
    )
    error_message = "Prod must publish its own roster parameters."
  }
}

// force_destroy empties dev buckets on teardown; it never makes the roster
// disposable.
run "force_destroy_keeps_roster_protection" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables {
    environment   = "dev"
    force_destroy = true
  }

  assert {
    condition     = aws_dynamodb_table.roster.deletion_protection_enabled
    error_message = "force_destroy must not turn off roster deletion protection."
  }
}
