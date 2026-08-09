module "bootstrap" {
  source = "../../modules/bootstrap"

  environment                    = "prod"
  aws_region                     = var.aws_region
  github_organization            = var.github_organization
  github_repository              = var.github_repository
  github_oidc_subject_repository = var.github_oidc_subject_repository
  github_environment_name        = var.github_environment_name
  github_oidc_provider_arn       = var.github_oidc_provider_arn
  state_bucket_name              = var.state_bucket_name
  create_terrateam_role          = var.create_terrateam_role
  create_cdk_deploy_role         = var.create_cdk_deploy_role
  tags                           = var.tags
}
