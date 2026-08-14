// The first Terrateam apply creates the shared prod foundation.
module "foundation" {
  source        = "../../modules/foundation"
  environment   = "prod"
  force_destroy = var.force_destroy
}
