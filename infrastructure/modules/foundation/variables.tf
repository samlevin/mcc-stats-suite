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
  description = "Create the dedicated trusted GitHub Actions S3 cache workload role using bootstrap resources."
  type        = bool
  default     = false
}

variable "cache_github_repository" {
  description = "Repository allowed to assume the cache role."
  type        = string
  default     = "samlevin/mcc-stats-suite"
}

variable "github_oidc_subject_repository" {
  description = "Repository segment in OIDC subjects; set owner@ID/repo@ID when immutable subjects are enabled, matching bootstrap."
  type        = string
  default     = null
}
