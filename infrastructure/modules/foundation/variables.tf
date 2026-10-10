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
  description = "Same-account workload roles allowed to access cache data. Keep empty until the cache service exists; never include GitHub Actions roles."
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
