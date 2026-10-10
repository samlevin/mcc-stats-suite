// Keep the allowlist narrow. A new or build-affecting path selects all checks.
const repositoryFiles = new Set([
  '.github/labels.json',
  '.github/workflows/issue-triage.yml',
  '.github/workflows/semantic.pr.yaml',
  '.github/workflows/secret-scan.yml',
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'LICENSE',
  'scripts/issue-triage.mjs',
  'scripts/issue-triage.test.mjs',
  'scripts/issue-containers.mjs',
]);

// Known workspaces. Shared with scripts/ci-checks.mjs so selection and Turbo
// affected mode never disagree about what counts as an application path.
export function isApplicationPath(path) {
  return /^(applications\/(admin|data-pipeline|match-to-csv|ocr-quality|player)|packages\/(contracts|cdk-config))\//.test(
    path,
  );
}

export function classify(path) {
  if (path.endsWith('.md')) return 'documentation';
  // .terrateam/config.yml is Prettier-formatted, so it stays on the full path
  // where format:check runs; full also selects the infrastructure job.
  if (path.startsWith('infrastructure/') && /\.(tf|tfvars|hcl)$/.test(path))
    return 'infrastructure';
  if (
    repositoryFiles.has(path) ||
    /^\.github\/ISSUE_TEMPLATE\/[^/]+\.ya?ml$/.test(path)
  )
    return 'repository';
  if (isApplicationPath(path)) return 'application';
  return 'full';
}

export function selectScopes(paths) {
  const scopes = paths.map(classify);
  return {
    full:
      !scopes.length ||
      scopes.includes('full') ||
      scopes.includes('application'),
    repository: scopes.includes('repository'),
    infrastructure:
      !scopes.length ||
      scopes.includes('infrastructure') ||
      scopes.includes('full'),
    check: !scopes.length || scopes.some((scope) => scope !== 'infrastructure'),
  };
}
