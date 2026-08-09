variable "aws_region" {
  description = "AWS region in which to store OpenTofu state."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment represented by this AWS account."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be either dev or prod."
  }
}

variable "github_organization" {
  description = "Case-sensitive GitHub organization or username that owns the repository."
  type        = string

  validation {
    condition     = length(trimspace(var.github_organization)) > 0
    error_message = "github_organization must not be empty."
  }
}

variable "github_repository" {
  description = "GitHub repository name, without the organization prefix."
  type        = string
  default     = "mcc-stats-suite"

  validation {
    condition     = length(trimspace(var.github_repository)) > 0
    error_message = "github_repository must not be empty."
  }
}

variable "github_oidc_subject_repository" {
  description = "Optional repository segment used in GitHub OIDC subjects. Set owner@ID/repo@ID when immutable subjects are enabled."
  type        = string
  default     = null
  nullable    = true
}

variable "github_environment_name" {
  description = "Protected GitHub Environment trusted to assume the CDK deployment role."
  type        = string
  default     = null
  nullable    = true
}

variable "github_deployment_branch" {
  description = "Branch whose committed GitHub deployment workflow may assume the CDK entry role."
  type        = string
  default     = "main"
}

variable "terrateam_workflow_path" {
  description = "Repository-relative Terrateam workflow path trusted by the Terrateam role."
  type        = string
  default     = ".github/workflows/terrateam.yml"
}

variable "cdk_workflow_name" {
  description = "GitHub Actions workflow name trusted by the CDK entry role."
  type        = string
  default     = "deploy-aws-application"
}

variable "project_name" {
  description = "Project prefix used for AWS resource names and tags."
  type        = string
  default     = "mcc-stats-suite"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-32 lowercase letters, numbers, or hyphens and cannot start or end with a hyphen."
  }
}

variable "state_bucket_name" {
  description = "Optional override for the globally unique state bucket name."
  type        = string
  default     = null
  nullable    = true
}

variable "github_oidc_provider_arn" {
  description = "ARN of an existing token.actions.githubusercontent.com OIDC provider. Leave null to create it."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.github_oidc_provider_arn == null ||
      can(regex("^arn:[^:]+:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com$", var.github_oidc_provider_arn))
    )
    error_message = "github_oidc_provider_arn must be a GitHub Actions OIDC provider ARN."
  }
}

variable "create_terrateam_role" {
  description = "Create the GitHub OIDC provider and Terrateam deployment role for a stable account."
  type        = bool
  default     = true
}

variable "create_cdk_deploy_role" {
  description = "Create the GitHub OIDC provider and CDK deployment entry role for a stable account."
  type        = bool
  default     = true
}

variable "terrateam_role_name" {
  description = "IAM role assumed by Terrateam through GitHub Actions OIDC."
  type        = string
  default     = null
  nullable    = true
}

variable "additional_terrateam_policy_arns" {
  description = "Additional managed policies to attach while expanding the platform. Prefer project-scoped policies."
  type        = set(string)
  default     = []
}

variable "cdk_deploy_role_name" {
  description = "IAM role assumed by the protected GitHub Environment for CDK deployments."
  type        = string
  default     = null
  nullable    = true
}

variable "additional_cdk_deploy_policy_arns" {
  description = "Additional managed policies for the GitHub CDK entry role."
  type        = set(string)
  default     = []
}

variable "tags" {
  description = "Additional tags to apply to bootstrap resources."
  type        = map(string)
  default     = {}
}
