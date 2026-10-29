// Keep the allowlist narrow. A new or build-affecting path selects all checks.
const repositoryFiles = new Set([
  '.github/labels.json',
  '.github/workflows/ci-pr-title.yml',
  '.github/workflows/ci-secret-scan.yml',
  '.github/workflows/board-issue-states.yml',
  '.github/workflows/board-pr-issue-status.yml',
  '.github/workflows/board-pr-metadata.yml',
  '.github/workflows/board-project-membership.yml',
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'LICENSE',
]);

// Known workspaces. Shared with scripts/ci-checks.mjs so selection and Turbo
// affected mode never disagree about what counts as an application path.
export function isApplicationPath(path) {
  return /^(applications\/(admin|data-pipeline|match-to-csv|ocr-quality|player)|packages\/(contracts|cdk-config))\//.test(
    path,
  );
}

// Agent workflow sources and the files agenticool-agents generates or syncs.
// Checked before the Markdown rule because many of them are Markdown, and
// editing one must run the generated-file check, not only the format check.
export function isAgentWorkflowPath(path) {
  return (
    /^\.agents\/(policy\.json|local\/|skills\/|[^/]+\.md$)/.test(path) ||
    /^\.(claude|codex)\/(agents|skills)\//.test(path) ||
    [
      'AGENTS.md',
      'ISSUE_TRIAGE.md',
      '.github/pull_request_template.md',
    ].includes(path)
  );
}

export function classify(path) {
  if (isAgentWorkflowPath(path)) return 'repository';
  if (path.endsWith('.md')) return 'documentation';
  // Templates under infrastructure/ are copied by operators, and
  // external-inputs.revision files only make Terrateam plan a root. Neither is
  // read by OpenTofu or a workspace build.
  if (
    path.startsWith('infrastructure/') &&
    (path.endsWith('.example') || path.endsWith('/external-inputs.revision'))
  )
    return 'documentation';
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

// Infrastructure and documentation have their own gates and are not workspace
// inputs. Root configuration and unknown paths require every workspace.
export function workspaceMode(paths, event) {
  const inputs = paths.filter(
    (path) => !['infrastructure', 'documentation'].includes(classify(path)),
  );
  return event === 'pull_request' &&
    inputs.length > 0 &&
    inputs.every(isApplicationPath)
    ? 'affected'
    : 'all';
}

export function selectScopes(paths, event) {
  const scopes = paths.map(classify);
  return {
    mode: workspaceMode(paths, event),
    full:
      !scopes.length ||
      scopes.includes('full') ||
      scopes.includes('application'),
    repository:
      scopes.includes('repository') || paths.includes('scripts/cli.cjs'),
    infrastructure:
      !scopes.length ||
      scopes.includes('infrastructure') ||
      scopes.includes('full'),
    check: !scopes.length || scopes.some((scope) => scope !== 'infrastructure'),
  };
}
