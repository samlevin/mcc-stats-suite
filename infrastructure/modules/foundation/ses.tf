// Inbound email is account-wide: a Region has one active receipt rule set.
// The foundation owns the rule set, its activation, and the shared
// <alias>@<domain> rule, and publishes the set's name, the alias, and the
// domain in SSM.
locals {
  receipt_rule_set_name = "mcc-inbound-${var.environment}"
}

resource "aws_ses_receipt_rule_set" "inbound" {
  rule_set_name = local.receipt_rule_set_name
}

// The rule's name is an AWS resource name, not part of the address.
resource "aws_ses_receipt_rule" "store_raw_email" {
  name          = "submit"
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
  recipients    = ["${var.email_alias}@${var.email_domain}"]
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

  // Other rules may be added to the set, so this rule's position is not
  // managed here.
  lifecycle {
    ignore_changes = [after]
  }
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

resource "aws_ssm_parameter" "email_domain" {
  name  = "/mcc/${var.environment}/match-to-csv/email-domain"
  type  = "String"
  value = var.email_domain
}

resource "aws_ssm_parameter" "email_alias" {
  name  = "/mcc/${var.environment}/match-to-csv/email-alias"
  type  = "String"
  value = var.email_alias
}

// The plan redacts the alias, so a changed alias would otherwise show only as
// a sensitive update to the shared rule. Compare it with the alias published
// now, or with submit, the alias before it was configurable, and warn when an
// apply would move the shared address: mail to the old address stops matching.
// The lookup by path succeeds before the parameter exists.
data "aws_ssm_parameters_by_path" "match_to_csv" {
  path = "/mcc/${var.environment}/match-to-csv"
}

check "shared_address_unchanged" {
  assert {
    condition = nonsensitive(lookup(
      zipmap(data.aws_ssm_parameters_by_path.match_to_csv.names, data.aws_ssm_parameters_by_path.match_to_csv.values),
      "/mcc/${var.environment}/match-to-csv/email-alias",
      "submit",
    ) == var.email_alias)
    error_message = "email_alias differs from the alias the foundation publishes now. Applying moves the shared submission address, and mail sent to the old address stops matching the shared rule."
  }
}
