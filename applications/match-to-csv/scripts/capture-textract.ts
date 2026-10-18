// Captures a real Textract response for a scoreboard screenshot, for building
// parser fixtures. It sends the same AnalyzeDocument request as the
// ExtractText Lambda and computes row colors with the Lambda's code, then
// writes the raw response and row colors to a directory outside the
// repository. It deploys nothing and writes nothing to S3.
//
// Usage, from applications/match-to-csv:
//   AWS_PROFILE=<dev profile> AWS_REGION=<region> \
//     npx tsx scripts/capture-textract.ts <output-dir> <image>...
//
// Each image produces <output-dir>/<image name>.capture.json. Screenshots and
// captures hold real gamertags: keep them out of the repository and reduce
// them with scripts/reduce-capture.ts.

import { CliHelp, cliError, defineCli, parseCli } from './cli';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AnalyzeDocumentCommand,
  TextractClient,
} from '@aws-sdk/client-textract';
import sharp from 'sharp';
import { MAX_IMAGE_BYTES } from '../src/lib/image-limits';
import {
  analyzeDocumentInput,
  computeRowColors,
  TEXTRACT_FEATURE_TYPES,
  toLiteBlock,
} from '../src/lib/textract-analysis';
import { assertOutsideRepository } from './fixture-paths';

const CLI = defineCli(
  'Usage: capture-textract.ts <output-dir> <image> [<image>...]',
);

async function main(argv: string[]): Promise<void> {
  const { positionals } = parseCli(argv, CLI);
  const [outputDirectory, ...images] = positionals;
  if (!outputDirectory || images.length === 0) {
    throw cliError(CLI, 'Name an output directory and at least one image');
  }
  assertOutsideRepository(outputDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const textract = new TextractClient({});

  for (const imagePath of images) {
    const image = fs.readFileSync(imagePath);
    const metadata = await sharp(image, { failOn: 'none' }).metadata();
    if (image.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`${imagePath} exceeds the Textract byte limit`);
    }
    if (!['png', 'jpeg', 'jpg'].includes(metadata.format ?? '')) {
      throw new Error(`${imagePath} is not a PNG or JPEG image`);
    }
    const target = path.join(
      outputDirectory,
      `${path.basename(imagePath)}.capture.json`,
    );
    if (fs.existsSync(target)) {
      throw new Error(`${target} exists; captures are never overwritten`);
    }

    const response = await textract.send(
      new AnalyzeDocumentCommand(analyzeDocumentInput(image)),
    );
    const rowColors = await computeRowColors(
      image,
      metadata.width ?? 0,
      metadata.height ?? 0,
      (response.Blocks ?? []).map(toLiteBlock),
    );
    fs.writeFileSync(
      target,
      `${JSON.stringify(
        {
          schemaVersion: 'textract-capture/v1',
          capturedAt: new Date().toISOString(),
          image: {
            fileName: path.basename(imagePath),
            sha256: createHash('sha256').update(image).digest('hex'),
            sizeBytes: image.byteLength,
            format: metadata.format,
            width: metadata.width,
            height: metadata.height,
          },
          request: {
            operation: 'AnalyzeDocument',
            featureTypes: [...TEXTRACT_FEATURE_TYPES],
          },
          rowColors,
          response,
        },
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    );
    process.stdout.write(
      `${target}: ${response.Blocks?.length ?? 0} blocks, ${rowColors.length} row colors\n`,
    );
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof CliHelp) {
    process.stdout.write(`${error.message}\n`);
    return;
  }
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
