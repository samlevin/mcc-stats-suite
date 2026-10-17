variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "project_name" {
  type    = string
  default = "mcc-stats-suite"
}

variable "force_destroy" {
  type    = bool
  default = false
}

variable "cache_service_role_arns" {
  description = "Same-account workload roles allowed to access cache data. Additional explicitly approved cache workload roles. The dedicated CI cache role is managed separately."
  type        = set(string)
  default     = []
  validation {
    condition = alltrue([
      for arn in var.cache_service_role_arns :
      can(regex("^arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/[A-Za-z0-9_+=,.@/-]+$", arn))
    ])
    error_message = "Cache access requires explicit same-account IAM role ARNs without wildcards."
  }
}

variable "create_github_cache_role" {
  description = "Create the dedicated trusted GitHub Actions S3 cache workload role using bootstrap resources. The role trusts the repository named by github_oidc_subject_repository and is skipped when that is unset."
  type        = bool
  default     = false
}

variable "create_local_cdk_policies" {
  description = "Create the five local CDK permission policies that the mcclocal1 bootstrap attaches by name. Only dev has local CDK deployments."
  type        = bool
  default     = false
  validation {
    condition     = !var.create_local_cdk_policies || var.environment == "dev"
    error_message = "create_local_cdk_policies is allowed only in dev."
  }
}

variable "github_oidc_subject_repository" {
  description = "Repository segment in OIDC subjects; set owner@ID/repo@ID when immutable subjects are enabled, matching bootstrap."
  type        = string
  default     = null
}

variable "email_domain" {
  description = "Verified SES domain that receives match-to-csv email. The shared rule accepts <email_alias>@ this domain. Sensitive so plan output posted to the public repository redacts it."
  type        = string
  sensitive   = true
  // Lowercase only, so a case difference never shows up as an unexplained,
  // redacted recipients change.
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.email_domain))
    error_message = "email_domain must be a lowercase bare domain name such as mail.example.com."
  }
}

variable "email_alias" {
  description = "Local part of the shared submission address, before the @. The shared rule accepts <email_alias>@<email_domain>, and ephemeral stacks use <email_alias>+<name>@<email_domain>. Sensitive so plan output posted to the public repository redacts it."
  type        = string
  sensitive   = true
  // Lowercase for the same reason as the domain. No +, which ephemeral
  // addresses use to separate the alias from the stack name, and only
  // characters that never need quoting before an @. At most 43 characters, so
  // <alias>+<name> with a 20-character ephemeral name stays within the
  // 64-character local part that RFC 5321 allows.
  validation {
    condition     = length(var.email_alias) <= 43 && can(regex("^[a-z0-9_-]+(\\.[a-z0-9_-]+)*$", var.email_alias))
    error_message = "email_alias must be a lowercase local part of at most 43 characters: letters, digits, _ or -, with single dots between them and no +."
  }
}
