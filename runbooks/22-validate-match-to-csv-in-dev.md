# Validate match-to-csv in dev

Use the web interfaces for this path.

1. In GitHub Actions, run `deploy-aws-application` for `match-to-csv` in `dev`.
2. Send a representative scoreboard email to the configured dev address.
3. In the dev account, open the new `match-to-csv-dev` Step Functions
   execution. Confirm every state succeeds.
4. Open the output CSV in S3 and compare player names and statistics with the
   image.

If it fails, inspect the failed state and its CloudWatch logs. If the output is
incorrect, compare the preprocessed image, OCR JSON, and CSV.

Next: [`30-promote-foundation-to-prod.md`](30-promote-foundation-to-prod.md).
