// These imports adopt the local CDK permission policies when they exist in AWS
// but not in state, so the local roles keep their boundary and policies. Once
// an address is in state, its import is a no-op.

data "aws_partition" "local_cdk_policies" {}

import {
  for_each = {
    workload_boundary  = "mcc-stats-suite-local-workload-boundary"
    execution_boundary = "mcc-stats-suite-local-cdk-execution-boundary"
    execution          = "mcc-stats-suite-local-cdk-execution"
    execution_compute  = "mcc-stats-suite-local-cdk-execution-compute"
    execution_events   = "mcc-stats-suite-local-cdk-execution-events"
  }
  to = module.foundation.aws_iam_policy.local_cdk[each.key]
  id = "arn:${data.aws_partition.local_cdk_policies.partition}:iam::${data.aws_caller_identity.foundation_recovery.account_id}:policy/${each.value}"
}
