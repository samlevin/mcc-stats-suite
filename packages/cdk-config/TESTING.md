# CDK deployment configuration testing

Run from the repository root:

```console
npm test --workspace @mcc/cdk-config
```

The suite covers explicit ephemeral names, stable dev and production names, ingress ownership, and AWS account mismatch rejection.
