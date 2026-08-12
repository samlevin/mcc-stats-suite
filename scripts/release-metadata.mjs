#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const releaseConfig = readJson('release-please-config.json');
const releaseManifest = readJson('.release-please-manifest.json');
const packageLock = readJson('package-lock.json');
const workspaces = discoverWorkspaces();
const packagesByName = new Map(
  workspaces.map((workspace) => [workspace.packageJson.name, workspace]),
);
const errors = validateReleaseConfiguration();

if (errors.length > 0) {
  for (const error of errors)
    process.stderr.write(`release config: ${error}\n`);
  process.exit(1);
}

const applicationIndex = process.argv.indexOf('--application');
if (applicationIndex !== -1) {
  const requested = process.argv[applicationIndex + 1];
  if (!requested || requested.startsWith('--')) {
    fail('--application requires a workspace name');
  }
  const workspace = packagesByName.get(`@mcc/${requested}`);
  if (!workspace || !workspace.path.startsWith('applications/')) {
    fail(`unknown application: ${requested}`);
  }
  const internalDependencies = Object.fromEntries(
    Object.entries(workspace.packageJson.dependencies ?? {})
      .filter(([name]) => packagesByName.has(name))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  process.stdout.write(
    JSON.stringify({
      application: {
        name: workspace.packageJson.name,
        version: workspace.packageJson.version,
      },
      sharedPackages: internalDependencies,
    }),
  );
} else if (!process.argv.includes('--check')) {
  fail('pass --check or --application <name>');
}

function discoverWorkspaces() {
  return ['applications', 'packages'].flatMap((parent) =>
    readdirSync(resolve(repositoryRoot, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`)
      .filter((path) => {
        try {
          readJson(`${path}/package.json`);
          return true;
        } catch {
          return false;
        }
      })
      .map((path) => ({ path, packageJson: readJson(`${path}/package.json`) })),
  );
}

function validateReleaseConfiguration() {
  const failures = [];
  const configuredPackages = releaseConfig.packages ?? {};
  const hasNodeWorkspacePlugin = (releaseConfig.plugins ?? []).some(
    (plugin) =>
      plugin === 'node-workspace' ||
      (typeof plugin === 'object' && plugin?.type === 'node-workspace'),
  );
  if (!hasNodeWorkspacePlugin) {
    failures.push('the node-workspace plugin is required');
  }

  const components = new Set();
  for (const workspace of workspaces) {
    const configured = configuredPackages[workspace.path];
    if (!configured) {
      failures.push(
        `${workspace.path} is missing from release-please-config.json`,
      );
      continue;
    }
    if (configured['package-name'] !== workspace.packageJson.name) {
      failures.push(
        `${workspace.path} package-name does not match ${workspace.packageJson.name}`,
      );
    }
    if (!configured.component) {
      failures.push(`${workspace.path} has no release component`);
    } else if (components.has(configured.component)) {
      failures.push(`release component ${configured.component} is duplicated`);
    } else {
      components.add(configured.component);
    }
    if (releaseManifest[workspace.path] !== workspace.packageJson.version) {
      failures.push(
        `${workspace.path} version ${workspace.packageJson.version} does not match manifest ${releaseManifest[workspace.path] ?? '(missing)'}`,
      );
    }
    const lockedWorkspace = packageLock.packages?.[workspace.path];
    if (lockedWorkspace?.version !== workspace.packageJson.version) {
      failures.push(
        `${workspace.path} version ${workspace.packageJson.version} does not match package-lock.json ${lockedWorkspace?.version ?? '(missing)'}`,
      );
    }
  }

  for (const path of Object.keys(configuredPackages)) {
    if (!workspaces.some((workspace) => workspace.path === path)) {
      failures.push(`${path} is configured for release but is not a workspace`);
    }
  }
  for (const path of Object.keys(releaseManifest)) {
    if (!workspaces.some((workspace) => workspace.path === path)) {
      failures.push(
        `${path} is in the release manifest but is not a workspace`,
      );
    }
  }

  for (const workspace of workspaces) {
    for (const [dependency, requestedVersion] of Object.entries({
      ...workspace.packageJson.dependencies,
      ...workspace.packageJson.devDependencies,
      ...workspace.packageJson.optionalDependencies,
    })) {
      const localDependency = packagesByName.get(dependency);
      if (!localDependency) continue;
      if (requestedVersion !== localDependency.packageJson.version) {
        failures.push(
          `${workspace.packageJson.name} pins ${dependency} at ${requestedVersion}; expected ${localDependency.packageJson.version}`,
        );
      }
      const lockedVersion =
        packageLock.packages?.[workspace.path]?.dependencies?.[dependency];
      if (lockedVersion !== requestedVersion) {
        failures.push(
          `${workspace.packageJson.name} dependency ${dependency} is ${requestedVersion} but package-lock.json contains ${lockedVersion ?? '(missing)'}`,
        );
      }
    }
  }

  return failures;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8'));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
