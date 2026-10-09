// These imports recover resources created before the foundation roots used
// persistent S3 state. Keep them as a record of resource origin; once an
// address is in state, its import is a no-op.

data "aws_caller_identity" "foundation_recovery" {}

data "aws_kms_alias" "foundation_recovery" {
  name = "alias/mcc-stats-suite-dev-application-data"
}

locals {
  foundation_recovery_buckets = {
    raw_email   = "mcc-stats-suite-dev-${data.aws_caller_identity.foundation_recovery.account_id}-raw-email"
    attachments = "mcc-stats-suite-dev-${data.aws_caller_identity.foundation_recovery.account_id}-attachments"
    output      = "mcc-stats-suite-dev-${data.aws_caller_identity.foundation_recovery.account_id}-match-output"
  }

  foundation_recovery_application_buckets = {
    attachments = local.foundation_recovery_buckets.attachments
    output      = local.foundation_recovery_buckets.output
  }

  foundation_recovery_evidence_bucket = "mcc-stats-suite-dev-${data.aws_caller_identity.foundation_recovery.account_id}-ocr-evidence"
}

import {
  to = module.foundation.aws_kms_key.data
  id = data.aws_kms_alias.foundation_recovery.target_key_id
}

import {
  to = module.foundation.aws_kms_alias.data
  id = data.aws_kms_alias.foundation_recovery.name
}

import {
  to = module.foundation.aws_s3_bucket.raw_email
  id = local.foundation_recovery_buckets.raw_email
}

import {
  to = module.foundation.aws_s3_bucket.attachments
  id = local.foundation_recovery_buckets.attachments
}

import {
  to = module.foundation.aws_s3_bucket.output
  id = local.foundation_recovery_buckets.output
}

import {
  to = module.foundation.aws_s3_bucket.evidence
  id = local.foundation_recovery_evidence_bucket
}

import {
  for_each = local.foundation_recovery_buckets
  to       = module.foundation.aws_s3_bucket_public_access_block.data[each.key]
  id       = each.value
}

import {
  for_each = local.foundation_recovery_buckets
  to       = module.foundation.aws_s3_bucket_versioning.data[each.key]
  id       = each.value
}

import {
  to = module.foundation.aws_s3_bucket_object_lock_configuration.evidence
  id = local.foundation_recovery_evidence_bucket
}

import {
  to = module.foundation.aws_s3_bucket_server_side_encryption_configuration.raw_email
  id = local.foundation_recovery_buckets.raw_email
}

import {
  for_each = local.foundation_recovery_application_buckets
  to       = module.foundation.aws_s3_bucket_server_side_encryption_configuration.application[each.key]
  id       = each.value
}

import {
  to = module.foundation.aws_s3_bucket_notification.raw_email
  id = local.foundation_recovery_buckets.raw_email
}

import {
  to = module.foundation.aws_s3_bucket_policy.raw_email
  id = local.foundation_recovery_buckets.raw_email
}

import {
  to = module.foundation.aws_ssm_parameter.raw_email_bucket_name
  id = "/mcc/dev/match-to-csv/raw-email-bucket-name"
}

import {
  to = module.foundation.aws_ssm_parameter.attachments_bucket_name
  id = "/mcc/dev/match-to-csv/attachments-bucket-name"
}

import {
  to = module.foundation.aws_ssm_parameter.output_bucket_name
  id = "/mcc/dev/match-to-csv/output-bucket-name"
}

import {
  to = module.foundation.aws_ssm_parameter.data_key_arn
  id = "/mcc/dev/match-to-csv/data-key-arn"
}

import {
  to = module.foundation.aws_ssm_parameter.evidence_bucket_name
  id = "/mcc/dev/match-to-csv/evidence-bucket-name"
}
