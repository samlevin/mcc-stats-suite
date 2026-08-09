module "foundation" {
  source        = "../../modules/foundation"
  environment   = "prod"
  force_destroy = var.force_destroy
}
