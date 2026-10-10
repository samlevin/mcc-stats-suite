// The first Terrateam apply creates the shared dev foundation.
module "foundation" {
  source                         = "../../modules/foundation"
  environment                    = "dev"
  force_destroy                  = var.force_destroy
  cache_service_role_arns        = var.cache_service_role_arns
  create_github_cache_role       = true
  github_oidc_subject_repository = var.github_oidc_subject_repository
}
