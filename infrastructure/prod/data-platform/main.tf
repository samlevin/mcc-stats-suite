module "data_platform" {
  source        = "../../modules/data-platform"
  environment   = "prod"
  force_destroy = var.force_destroy
}
