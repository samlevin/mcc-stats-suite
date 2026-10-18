# CDK deployment configuration testing

Run from the repository root:

```console
npm test --workspace @mcc/cdk-config
```

The suite covers explicit ephemeral names, reserved and malformed names, dev and production names, bootstrap qualifier, runtime boundary, and role path selection, and AWS account mismatch rejection.

`scripts/local-cdk-bootstrap.test.mjs` checks the custom local bootstrap policies against the pinned CDK template, and checks that the template committed in `infrastructure/dev/local-cdk` matches a fresh generation. It also synthesizes every application as an ephemeral stack, and keeps the wrapper's ephemeral name rule identical to `resolveDeployment`. It makes no AWS calls. Live IAM validation is described in [Local CDK bootstrap design](../../docs/local-cdk-bootstrap-design.md#validate-the-boundary).
