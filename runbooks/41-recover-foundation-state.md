# Recover foundation state after a local-backend apply

Use this procedure only when Terrateam created foundation resources while OpenTofu was using local state. It repairs state ownership without recreating or replacing durable resources.

The foundation roots declare the S3 backend and retain declarative imports for resources created before persistent state was configured. The import IDs use the active AWS account and established resource names. The KMS import follows the existing application-data alias, which identifies the key already published through Parameter Store and used by the application buckets.

## Stop and inspect

1. Do not retry either foundation apply. Reject any plan that proposes creating the existing KMS alias, application buckets, or SSM parameters.
2. Confirm the pull-request SHA and read the complete failed apply logs for both environments. Record every resource that completed creation.
3. Verify that the state bucket and AWS region variables point to the intended environment. Confirm the AWS account before approving any plan.
4. Check whether `operational/foundation.tfstate` already exists in the environment's state bucket. If it contains resources, stop and compare that state with the import blocks before proceeding. Do not import one AWS object to two addresses.

## Recover dev

1. Request a fresh dev-only plan:

   ```text
   terrateam plan dev and foundation
   ```

2. Confirm that initialization selects the S3 backend without a missing-backend warning.
3. Review every import and every proposed change. The recovery plan should import the original KMS key targeted by the existing alias, the alias, the three application buckets and their existing configuration resources, their SSM parameters, and the partially created evidence bucket resources.
4. The plan may create the controls that the failed apply did not reach: the evidence bucket public-access block, versioning resource, and KMS encryption configuration, plus the raw-email lifecycle rule. Reject replacements and deletions.
5. Apply dev only:

   ```text
   terrateam apply dev and foundation
   ```

6. Request another dev plan. It must be empty before application validation begins.

## Recover prod

Recover production from the same unchanged commit only after dev has an empty plan and the affected application behavior passes validation.

1. Request and inspect a prod-only plan:

   ```text
   terrateam plan prod and foundation
   ```

2. Compare the imports and changes with the validated dev recovery. Reject replacements, deletions, or any attempt to create an existing named resource.
3. Apply prod only after explicit production authorization:

   ```text
   terrateam apply prod and foundation
   ```

4. Request another prod plan and require it to be empty.

## Handle duplicate KMS keys

Each failed apply created an unaliased KMS key before alias creation failed. The recovery imports the key targeted by the established alias and leaves the duplicate key unmanaged.

For each environment, identify the duplicate from the failed apply log and verify all of the following before scheduling deletion:

- the application-data alias does not target it;
- the data-key SSM parameter does not contain its ARN;
- no bucket default-encryption configuration references it;
- no application configuration or stored object depends on it.

Schedule deletion only as a separate, explicitly authorized operation. Keep the full KMS waiting period appropriate for the environment. Do not add the duplicate key to OpenTofu state.
