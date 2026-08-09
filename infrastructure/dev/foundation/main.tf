module "foundation" {
  source        = "../../modules/foundation"
  environment   = "dev"
  force_destroy = var.force_destroy
}
