output "aws_account_id" {
  description = "AWS account bootstrapped for this environment."
  value       = local.account_id
}

output "aws_region" {
  description = "AWS region containing the state bucket."
  value       = var.aws_region
}

output "state_bucket_name" {
  description = "S3 bucket to use for all OpenTofu remote state in this AWS account."
  value       = aws_s3_bucket.state.id
}

output "github_oidc_provider_arn" {
  description = "GitHub Actions OIDC provider used by Terrateam and future CDK workflows."
  value       = local.github_oidc_provider_arn
}

output "workload_boundary_arn" {
  description = "Permissions boundary applied by project CDK stacks to runtime roles."
  value       = aws_iam_policy.workload_boundary.arn
}

output "terrateam_role_arn" {
  description = "Configure this role ARN in the Terrateam AWS OIDC hook."
  value       = try(aws_iam_role.terrateam[0].arn, null)
}

output "cdk_deploy_role_arn" {
  description = "Configure this role ARN on the matching protected GitHub Environment."
  value       = try(aws_iam_role.cdk_deploy[0].arn, null)
}

output "github_oidc_subjects" {
  description = "OIDC subjects trusted by the two bootstrap-managed CI roles."
  value = {
    terrateam = local.terrateam_github_subject
    cdk       = local.cdk_github_subject
  }
}

output "bootstrap_backend_config" {
  description = "Values for backend.hcl after the first local apply."
  value = {
    bucket       = aws_s3_bucket.state.id
    key          = "${var.environment}/bootstrap/opentofu.tfstate"
    region       = var.aws_region
    encrypt      = true
    use_lockfile = true
  }
}

output "terrateam_oidc_hook" {
  description = "Terrateam configuration fragment for this environment."
  value       = var.create_terrateam_role ? "- type: oidc\n  provider: aws\n  role_arn: \"${aws_iam_role.terrateam[0].arn}\"\n" : null
}
