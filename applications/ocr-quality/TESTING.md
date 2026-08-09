# OCR quality testing

Run from the repository root:

```console
npm test --workspace @mcc/ocr-quality
npm run app:synth -- ocr-quality
```

The current test verifies the workspace boundary. Add unit tests beside each
quality rule and integration tests when the Step Functions workflow is added.
