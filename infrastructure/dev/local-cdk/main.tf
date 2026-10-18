# The restricted CDK bootstrap that ephemeral stacks deploy through. Regenerate
# bootstrap-template.yaml with `npm run cdk:local-template`; never run
# `cdk bootstrap` for the mcclocal1 qualifier. CloudFormation creates the
# stack's IAM roles and policies with the caller's credentials, which the dev
# bootstrap grants the Terrateam role for this stack only.
resource "aws_cloudformation_stack" "local_cdk_toolkit" {
  name          = "CDKToolkitLocal"
  template_body = file("${path.module}/bootstrap-template.yaml")
  capabilities  = ["CAPABILITY_NAMED_IAM"]

  # Stops any update from deleting or replacing the local permission policies,
  # so a stock CDK template cannot restore the AdministratorAccess execution
  # policy.
  policy_body = file("${path.module}/stack-policy.json")

  parameters = {
    Qualifier = "mcclocal1"
    # The value `cdk bootstrap` passes. The template's empty default creates a
    # customer-managed KMS key for the staging bucket instead.
    FileAssetsBucketKmsKeyId = "AWS_MANAGED_KEY"
  }

  lifecycle {
    prevent_destroy = true
  }
}
