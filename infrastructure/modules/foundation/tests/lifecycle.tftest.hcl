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

override_resource {
  target = aws_s3_bucket.attachments
  values = { id = "test-attachments" }
}

override_resource {
  target = aws_s3_bucket.output
  values = { id = "test-output" }
}

run "dev_ephemeral_expiry" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables { environment = "dev" }

  assert {
    condition = (
      toset(keys(aws_s3_bucket_lifecycle_configuration.ephemeral)) == toset(["attachments", "output"]) &&
      alltrue([
        for lifecycle in aws_s3_bucket_lifecycle_configuration.ephemeral :
        length(lifecycle.rule) == 1 &&
        one(lifecycle.rule).status == "Enabled" &&
        one(lifecycle.rule).filter[0].prefix == "ephemeral/" &&
        one(lifecycle.rule).expiration[0].days == 30 &&
        one(lifecycle.rule).noncurrent_version_expiration[0].noncurrent_days == 30
      ])
    )
    error_message = "Only attachment/output ephemeral/ versions must expire, 30 days after creation or becoming noncurrent."
  }

  assert {
    condition = (
      aws_s3_bucket_lifecycle_configuration.ephemeral["attachments"].bucket == aws_s3_bucket.attachments.id &&
      aws_s3_bucket_lifecycle_configuration.ephemeral["output"].bucket == aws_s3_bucket.output.id &&
      alltrue([for versioning in aws_s3_bucket_versioning.data : versioning.versioning_configuration[0].status == "Enabled"])
    )
    error_message = "Lifecycle rules must target the versioned attachments and output buckets."
  }

  assert {
    condition = (
      length(aws_s3_bucket_lifecycle_configuration.raw_email.rule) == 1 &&
      coalesce(one(aws_s3_bucket_lifecycle_configuration.raw_email.rule).filter[0].prefix, "all") == "all" &&
      one(aws_s3_bucket_lifecycle_configuration.raw_email.rule).expiration[0].days == 90 &&
      one(aws_s3_bucket_lifecycle_configuration.raw_email.rule).noncurrent_version_expiration[0].noncurrent_days == 1 &&
      aws_s3_bucket.evidence.object_lock_enabled &&
      aws_s3_bucket_object_lock_configuration.evidence.rule[0].default_retention[0].mode == "GOVERNANCE" &&
      aws_s3_bucket_object_lock_configuration.evidence.rule[0].default_retention[0].days == 365
    )
    error_message = "Existing raw MIME expiry and evidence retention must remain unchanged."
  }
}

run "prod_ephemeral_expiry" {
  command = plan
  plan_options { refresh = false }
  module { source = "../../modules/foundation" }
  variables { environment = "prod" }

  assert {
    condition = (
      toset(keys(aws_s3_bucket_lifecycle_configuration.ephemeral)) == toset(["attachments", "output"]) &&
      alltrue([
        for lifecycle in aws_s3_bucket_lifecycle_configuration.ephemeral :
        length(lifecycle.rule) == 1 &&
        one(lifecycle.rule).status == "Enabled" &&
        one(lifecycle.rule).filter[0].prefix == "ephemeral/" &&
        one(lifecycle.rule).expiration[0].days == 30 &&
        one(lifecycle.rule).noncurrent_version_expiration[0].noncurrent_days == 30
      ])
    )
    error_message = "Only attachment/output ephemeral/ versions must expire, 30 days after creation or becoming noncurrent."
  }

  assert {
    condition = (
      aws_s3_bucket_lifecycle_configuration.ephemeral["attachments"].bucket == aws_s3_bucket.attachments.id &&
      aws_s3_bucket_lifecycle_configuration.ephemeral["output"].bucket == aws_s3_bucket.output.id &&
      alltrue([for versioning in aws_s3_bucket_versioning.data : versioning.versioning_configuration[0].status == "Enabled"])
    )
    error_message = "Lifecycle rules must target the versioned attachments and output buckets."
  }

  assert {
    condition = (
      length(aws_s3_bucket_lifecycle_configuration.raw_email.rule) == 1 &&
      coalesce(one(aws_s3_bucket_lifecycle_configuration.raw_email.rule).filter[0].prefix, "all") == "all" &&
      one(aws_s3_bucket_lifecycle_configuration.raw_email.rule).expiration[0].days == 90 &&
      one(aws_s3_bucket_lifecycle_configuration.raw_email.rule).noncurrent_version_expiration[0].noncurrent_days == 1 &&
      aws_s3_bucket.evidence.object_lock_enabled &&
      aws_s3_bucket_object_lock_configuration.evidence.rule[0].default_retention[0].mode == "GOVERNANCE" &&
      aws_s3_bucket_object_lock_configuration.evidence.rule[0].default_retention[0].days == 365
    )
    error_message = "Existing raw MIME expiry and evidence retention must remain unchanged."
  }
}

