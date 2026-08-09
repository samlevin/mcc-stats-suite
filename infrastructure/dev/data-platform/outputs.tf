output "data_platform" {
  value = {
    layer_bucket_names    = module.data_platform.layer_bucket_names
    catalog_database_name = module.data_platform.catalog_database_name
    athena_workgroup_name = module.data_platform.athena_workgroup_name
    lakehouse_key_arn     = module.data_platform.lakehouse_key_arn
  }
}
