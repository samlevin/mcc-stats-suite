import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import * as path from 'path';
import { version as esbuildVersion } from 'esbuild/package.json';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';

export { esbuildVersion };

/**
 * SAM build image digest for Node.js 22 (multi-architecture index), so CI and
 * deployments bundle with the same image. CDK overwrites a `buildArgs.IMAGE`
 * option, so the pin travels on the runtime instead.
 *
 * To update: run `docker buildx imagetools inspect
 * public.ecr.aws/sam/build-nodejs22.x:latest`, copy the top-level `Digest`
 * here, then run `npm run verify:bundle --workspace @mcc/match-to-csv`.
 */
export const BUNDLING_IMAGE =
  'public.ecr.aws/sam/build-nodejs22.x@sha256:8c7d07d694ff713755c4722e1123629fdb19edb6b3937ebe4e789f4eb678959a';

/** The Node.js 22 Lambda runtime with a digest-pinned bundling image. */
export const bundlingRuntime = new lambda.Runtime(
  lambda.Runtime.NODEJS_22_X.name,
  lambda.RuntimeFamily.NODEJS,
  { bundlingDockerImage: BUNDLING_IMAGE },
);

/** Bundling options shared by every match-to-csv function. */
export function bundlingOptions(
  includeSharp: boolean,
  bundlingRequired: boolean,
): lambdaNode.BundlingOptions {
  return {
    minify: true,
    sourceMap: true,
    target: 'node22',
    nodeModules: includeSharp ? ['sharp'] : undefined,
    // Only Docker bundling installs this version: the Sharp functions, or every
    // function when esbuild is missing locally. checkLocalEsbuild covers the rest.
    esbuildVersion,
    // NodejsFunction builds its Docker image eagerly; skip it when bundling is skipped.
    forceDockerBundling: includeSharp && bundlingRequired,
  };
}

/**
 * Finds the esbuild CDK bundles with locally: a package resolvable from
 * aws-cdk-lib, otherwise `esbuild` on PATH. Undefined means CDK falls back to
 * Docker bundling for every function.
 */
export function localEsbuildVersion(): string | undefined {
  try {
    const cdkRoot = path.dirname(require.resolve('aws-cdk-lib/package.json'));
    const manifest = require.resolve('esbuild/package.json', {
      paths: [cdkRoot],
    });
    return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string })
      .version;
  } catch {
    const result = spawnSync('esbuild', ['--version'], { encoding: 'utf8' });
    return result.status === 0 && !result.error
      ? result.stdout.trim()
      : undefined;
  }
}

/** Fails synthesis when local bundling would use a different esbuild than Docker. */
export function checkLocalEsbuild(local: string | undefined): void {
  if (local !== undefined && local !== esbuildVersion)
    throw new Error(
      `Local esbuild ${local} differs from the locked ${esbuildVersion}. Run CDK through the npm scripts so the workspace esbuild is on PATH.`,
    );
}
