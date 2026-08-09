variable "aws_region" {
  description = "AWS region in which to store OpenTofu state."
  type        = string
  default     = "us-east-1"
}

variable "github_organization" {
  description = "Case-sensitive GitHub organization or username that owns the repository."
  type        = string
}

variable "github_repository" {
  description = "GitHub repository name, without the organization prefix."
  type        = string
  default     = "mcc-stats-suite"
}

variable "github_oidc_subject_repository" {
  description = "Optional owner@ID/repo@ID segment for immutable GitHub OIDC subjects."
  type        = string
  default     = null
  nullable    = true
}

variable "github_environment_name" {
  description = "Protected GitHub Environment trusted for CDK deployment."
  type        = string
  default     = "prod"
}

variable "github_oidc_provider_arn" {
  description = "ARN of an existing GitHub Actions OIDC provider. Leave null to create it."
  type        = string
  default     = null
  nullable    = true
}

variable "state_bucket_name" {
  description = "Optional override for the globally unique state bucket name."
  type        = string
  default     = null
  nullable    = true
}

variable "create_terrateam_role" {
  description = "Create Terrateam access for the prod account."
  type        = bool
  default     = true
}

variable "create_cdk_deploy_role" {
  description = "Create GitHub CDK access for the prod account."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Additional tags to apply to bootstrap resources."
  type        = map(string)
  default     = {}
}
