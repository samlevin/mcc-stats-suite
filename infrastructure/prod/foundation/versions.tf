terraform {
  required_version = "~> 1.12.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = "mcc"
      Environment = "prod"
      ManagedBy   = "opentofu"
      Release     = local.release_id
    }
  }
}
