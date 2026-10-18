// The gamertag roster (spec 1.2 §5.1, §13.2). The table is an append-only change
// log with one partition per namespace. It outlives every application stack, so
// the foundation owns it like the evidence bucket, and CDK stacks only read its
// name and ARN from SSM. The application data key encrypts it, including its
// point-in-time backups.
//
// Never manage items here, so roster contents stay out of OpenTofu state and
// plan output.
resource "aws_dynamodb_table" "roster" {
  name                        = "${local.name}-gamertag-roster"
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

  // force_destroy never applies to the roster, in dev or prod. Removing the
  // table takes a reviewed change to this block and to deletion protection.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_ssm_parameter" "roster_table_name" {
  name  = "/mcc/${var.environment}/roster/table-name"
  type  = "String"
  value = aws_dynamodb_table.roster.name
}

resource "aws_ssm_parameter" "roster_table_arn" {
  name  = "/mcc/${var.environment}/roster/table-arn"
  type  = "String"
  value = aws_dynamodb_table.roster.arn
}
