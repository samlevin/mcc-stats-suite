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
