terraform {
  required_version = "~> 1.12.0"

  backend "s3" {
    key          = "operational/foundation.tfstate"
    encrypt      = true
    use_lockfile = true
  }

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
      Environment = "dev"
      ManagedBy   = "opentofu"
    }
  }
}
