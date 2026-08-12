# Validate match-to-csv in dev

Run this integration test only after local checks pass and the dev foundation is current.

1. Merge the application change to `main` after CI passes on its pull request.
2. Confirm the `ci` workflow identifies `match-to-csv`, deploys the merged commit SHA to `dev`, and records a successful GitHub Deployment for the `deploy:match-to-csv` task.
3. Confirm the prerequisite, synthesis, native bundle, deployment, and deployed-resource verification steps succeed.
4. Submit a representative PNG or JPEG screenshot through the privately configured inbound recipient.
5. Open the new `match-to-csv-dev` Step Functions execution and confirm every state succeeds.
6. Follow the execution output to the evidence bucket. Confirm the source image, metadata, run manifest, start and success events, Textract request and response, normalized observations, extracted table, CSV, and successful completion object exist.
7. Compare the CSV with the screenshot. Treat OCR differences as observations to label, not as evidence corruption.

For a failure test, use an unsupported or undersized image. Confirm the submission records a rejection and the workflow does not report a successful empty result. For a provider failure, confirm the run contains `RUN_STARTED`, `RUN_FAILED`, the provider request, and a failed completion object.

Do not add the integration input or private recipient configuration to the repository.

Continue with [30-promote-foundation-to-prod.md](30-promote-foundation-to-prod.md).
