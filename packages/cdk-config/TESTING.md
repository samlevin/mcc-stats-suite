# CDK deployment configuration testing

Run from the repository root:

```console
npm test --workspace @samlevin/cdk-config
```

The suite covers explicit ephemeral names, dev and production names, bootstrap qualifier and runtime boundary selection, ingress ownership, and AWS account mismatch rejection.

Run `node --test scripts/local-cdk-bootstrap.test.mjs` to check the custom local bootstrap policies against the pinned CDK template without AWS calls. Live IAM validation is described in [Self-hosting](../../docs/self-hosting/20-bootstrap-cdk.md#validate-the-boundary).
