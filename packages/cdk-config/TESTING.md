# CDK deployment configuration testing

Run from the repository root:

```console
npm test --workspace @samlevin/cdk-config
```

The suite covers explicit ephemeral names, reserved and malformed names, dev and production names, bootstrap qualifier, runtime boundary, and role path selection, ingress ownership, and AWS account mismatch rejection.

`scripts/local-cdk-bootstrap.test.mjs` checks the custom local bootstrap policies against the pinned CDK template. It also synthesizes every application as an ephemeral stack, and keeps the wrapper's ephemeral name rule identical to `resolveDeployment`. It makes no AWS calls. Live IAM validation is described in [Self-hosting](../../docs/self-hosting/20-bootstrap-cdk.md#validate-the-boundary).
