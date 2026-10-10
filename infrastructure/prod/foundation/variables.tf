variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "force_destroy" {
  type    = bool
  default = false
}

variable "cache_service_role_arns" {
  description = "Additional approved cache workload roles."
  type        = set(string)
  default     = []
}

variable "github_oidc_subject_repository" {
  description = "OIDC subject repository segment matching bootstrap, including immutable IDs when enabled."
  type        = string
  default     = null
}
