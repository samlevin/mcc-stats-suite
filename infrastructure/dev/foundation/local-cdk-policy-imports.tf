// The mcclocal1 CDK bootstrap created the local CDK permission policies before
// the foundation owned them. The foundation adopts them instead of creating new
// ones, so the local roles never lose their boundary or policies while the
// bootstrap stops defining them. Keep these imports as a record of resource
// origin; once an address is in state, its import is a no-op.

data "aws_partition" "local_cdk_handover" {}

import {
  for_each = {
    workload_boundary  = "mcc-stats-suite-local-workload-boundary"
    execution_boundary = "mcc-stats-suite-local-cdk-execution-boundary"
    execution          = "mcc-stats-suite-local-cdk-execution"
    execution_compute  = "mcc-stats-suite-local-cdk-execution-compute"
    execution_events   = "mcc-stats-suite-local-cdk-execution-events"
  }
  to = module.foundation.aws_iam_policy.local_cdk[each.key]
  id = "arn:${data.aws_partition.local_cdk_handover.partition}:iam::${data.aws_caller_identity.foundation_recovery.account_id}:policy/${each.value}"
}
