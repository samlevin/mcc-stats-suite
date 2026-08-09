output "foundation" {
  value = {
    raw_email_bucket_name   = module.foundation.raw_email_bucket_name
    attachments_bucket_name = module.foundation.attachments_bucket_name
    output_bucket_name      = module.foundation.output_bucket_name
    data_key_arn            = module.foundation.data_key_arn
  }
}
