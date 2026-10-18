// The CSV recipient list (spec 1.1 §4.5): the addresses that receive each
// submission's per-gamertag CSVs. The table is an append-only change log with
// one partition per namespace, laid out like the gamertag roster. A separate
// table keeps email addresses apart from gamertags and lets a stack be granted
// the recipient list alone. It outlives every application stack, so the
// foundation owns it, and CDK stacks only read its name and ARN from SSM. The
// application data key encrypts it, including its point-in-time backups.
//
// Never manage items here, so addresses stay out of OpenTofu state and plan
// output.
resource "aws_dynamodb_table" "recipients" {
  name                        = "${local.name}-csv-recipients"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = true

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.data.arn
  }

  // force_destroy never applies to the recipient list, in dev or prod.
  // Removing the table takes a reviewed change to this block and to deletion
  // protection.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_ssm_parameter" "recipients_table_name" {
  name  = "/mcc/${var.environment}/recipients/table-name"
  type  = "String"
  value = aws_dynamodb_table.recipients.name
}

resource "aws_ssm_parameter" "recipients_table_arn" {
  name  = "/mcc/${var.environment}/recipients/table-arn"
  type  = "String"
  value = aws_dynamodb_table.recipients.arn
}
