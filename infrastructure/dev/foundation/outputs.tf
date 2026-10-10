output "foundation" {
  value = {
    raw_email_bucket_name   = module.foundation.raw_email_bucket_name
    attachments_bucket_name = module.foundation.attachments_bucket_name
    output_bucket_name      = module.foundation.output_bucket_name
    data_key_arn            = module.foundation.data_key_arn
    turbo_cache_bucket_name = module.foundation.turbo_cache_bucket_name
    turbo_cache_key_arn     = module.foundation.turbo_cache_key_arn
  }
}

output "turbo_cache_service_policy_json" {
  value = module.foundation.turbo_cache_service_policy_json
}

output "github_turbo_cache_role_arn" {
  value = module.foundation.github_turbo_cache_role_arn
}
