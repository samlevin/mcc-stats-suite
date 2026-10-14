import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import * as path from 'path';
import { version as esbuildVersion } from 'esbuild/package.json';
import type * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';

export { esbuildVersion };

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
