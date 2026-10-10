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

export function classify(path) {
  if (path.endsWith('.md')) return 'documentation';
  if (
    (path.startsWith('infrastructure/') && /\.(tf|tfvars|hcl)$/.test(path)) ||
    path === '.terrateam/config.yml'
  )
    return 'infrastructure';
  if (
    repositoryFiles.has(path) ||
    /^\.github\/ISSUE_TEMPLATE\/[^/]+\.ya?ml$/.test(path)
  )
    return 'repository';
  if (
    /^(applications\/(admin|data-pipeline|match-to-csv|ocr-quality|player)|packages\/(contracts|cdk-config))\//.test(
      path,
    )
  )
    return 'application';
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
    application: scopes.includes('application'),
    infrastructure:
      !scopes.length ||
      scopes.includes('infrastructure') ||
      scopes.includes('full'),
    check: !scopes.length || scopes.some((scope) => scope !== 'infrastructure'),
  };
}
