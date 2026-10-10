module "foundation" {
  source                  = "../../modules/foundation"
  environment             = "prod"
  force_destroy           = var.force_destroy
  cache_service_role_arns = var.cache_service_role_arns
}
