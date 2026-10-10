variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "force_destroy" {
  type    = bool
  default = false
}

variable "cache_service_role_arns" {
  description = "Explicit future cache service workload roles. Empty until a service is selected; never GitHub Actions roles."
  type        = set(string)
  default     = []
}
