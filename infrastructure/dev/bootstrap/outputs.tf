output "aws_account_id" {
  value = module.bootstrap.aws_account_id
}

output "state_bucket_name" {
  value = module.bootstrap.state_bucket_name
}

output "github_oidc_provider_arn" {
  value = module.bootstrap.github_oidc_provider_arn
}

output "workload_boundary_arn" {
  value = module.bootstrap.workload_boundary_arn
}

output "terrateam_role_arn" {
  value = module.bootstrap.terrateam_role_arn
}

output "cdk_deploy_role_arn" {
  value = module.bootstrap.cdk_deploy_role_arn
}

output "github_oidc_subjects" {
  value = module.bootstrap.github_oidc_subjects
}

output "bootstrap_backend_config" {
  value = module.bootstrap.bootstrap_backend_config
}

output "terrateam_oidc_hook" {
  value = module.bootstrap.terrateam_oidc_hook
}
