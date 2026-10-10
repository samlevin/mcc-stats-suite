// Inbound email is an account-wide resource: a Region has one active receipt
// rule set. The foundation owns the rule set, its activation, and the shared
// submit@ rule. Application stacks only add per-developer rules to this set.
// Names match the ones CDK used before ownership moved, so existing rule sets
// import without replacement.
locals {
  receipt_rule_set_name = "mcc-match-to-csv-${var.environment}"
  receipt_rule_name     = "match-to-csv-${var.environment}"
}

resource "aws_ses_receipt_rule_set" "inbound" {
  rule_set_name = local.receipt_rule_set_name
}

resource "aws_ses_receipt_rule" "store_raw_email" {
  name          = local.receipt_rule_name
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
  recipients    = ["submit@${var.email_domain}"]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Optional"

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.raw_email.id
    object_key_prefix = "incoming/${var.environment}/"
  }

  stop_action {
    position = 2
    scope    = "RuleSet"
  }

  // SES checks that it can write to the bucket when the rule is saved.
  depends_on = [aws_s3_bucket_policy.raw_email]
}

resource "aws_ses_active_receipt_rule_set" "inbound" {
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name

  // Activate only once the shared rule exists, so mail is never accepted
  // into an empty rule set.
  depends_on = [aws_ses_receipt_rule.store_raw_email]
}

resource "aws_ssm_parameter" "receipt_rule_set_name" {
  name  = "/mcc/${var.environment}/match-to-csv/receipt-rule-set-name"
  type  = "String"
  value = aws_ses_receipt_rule_set.inbound.rule_set_name
}
