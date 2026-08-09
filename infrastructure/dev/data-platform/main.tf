module "data_platform" {
  source        = "../../modules/data-platform"
  environment   = "dev"
  force_destroy = var.force_destroy
}
