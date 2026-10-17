# CDK deployment configuration testing

Run from the repository root:

```console
npm test --workspace @mcc/cdk-config
```

The suite covers explicit ephemeral names, reserved and malformed names, dev and production names, bootstrap qualifier, runtime boundary, and role path selection, and AWS account mismatch rejection.

`scripts/local-cdk-bootstrap.test.mjs` checks the custom local bootstrap template against the pinned CDK template. It also synthesizes every application as an ephemeral stack, and keeps the wrapper's ephemeral name rule identical to `resolveDeployment`. It makes no AWS calls. The local permission policies, including the runtime boundary named here, belong to the dev foundation, and `infrastructure/modules/foundation/tests/local-cdk-policy-names.tftest.hcl` checks that this package uses the boundary's name. Live IAM validation is described in [Local CDK bootstrap design](../../docs/local-cdk-bootstrap-design.md#validate-the-boundary).
