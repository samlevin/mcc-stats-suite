# CDK deployment configuration testing

Run from the repository root:

```console
npm test --workspace @mcc/cdk-config
```

The suite covers personal names such as `match-to-csv-sam`, stable names such
as `match-to-csv-dev` and `match-to-csv-prod`, required instances, ingress
ownership, and AWS account mismatch rejection.
