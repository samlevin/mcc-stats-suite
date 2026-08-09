// The first Terrateam apply creates the shared dev foundation.
module "foundation" {
  source        = "../../modules/foundation"
  environment   = "dev"
  force_destroy = var.force_destroy
}
