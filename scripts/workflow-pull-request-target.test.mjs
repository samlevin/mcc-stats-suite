import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { workflow } from './workflow-test-helpers.mjs';

// A `pull_request_target` workflow runs with the base repository's token and
// secrets, so it must only run trusted default-branch code. No checkout may
// select the pull request's head or another repository, and no `run` step may
// fetch the head.

const triggers = (definition) => {
  const on = definition?.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on;
  return on && typeof on === 'object' ? Object.keys(on) : [];
};

const isPullRequestTarget = (definition) =>
  triggers(definition).includes('pull_request_target');

// Expressions that name the pull request's head commit, branch, or ref.
const PR_HEAD =
  /github\.event\.pull_request\.head\.|github\.head_ref|refs\/pull\/|pull\/[^/\n]*\/(?:head|merge)\b/;
// Expressions that name the base repository.
const BASE_REPOSITORY = new Set([
  'github.repository',
  'github.event.repository.full_name',
  'github.event.pull_request.base.repo.full_name',
]);
const isBaseRepository = (value) =>
  value === 'samlevin/mcc-stats-suite' ||
  BASE_REPOSITORY.has(expression(value));
const FETCH = /\bgit\s+(?:[\w.-]+\s+)*?fetch\b|\bgh\s+pr\s+checkout\b/;

const expression = (value) =>
  /^\$\{\{\s*([^}]*?)\s*\}\}$/.exec(String(value).trim())?.[1];

const isCheckout = (step) =>
  typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@');

const envText = (...scopes) =>
  scopes.flatMap((env) => Object.values(env ?? {}).map(String)).join('\n');

const untrustedCode = (definition) => {
  if (!isPullRequestTarget(definition)) return [];
  const problems = [];
  for (const [id, job] of Object.entries(definition.jobs ?? {})) {
    (job?.steps ?? []).forEach((step, index) => {
      const label = `${id} step ${index + 1} (${step.name ?? step.uses ?? 'run'})`;
      if (isCheckout(step)) {
        const { ref, repository } = step.with ?? {};
        if (ref !== undefined && PR_HEAD.test(String(ref))) {
          problems.push(`${label} checks out the pull request head: ${ref}`);
        }
        if (repository !== undefined && !isBaseRepository(repository)) {
          problems.push(
            `${label} checks out a repository other than the base repository: ${repository}`,
          );
        }
      }
      if (typeof step.run === 'string' && FETCH.test(step.run)) {
        const context = `${step.run}\n${envText(definition.env, job.env, step.env)}`;
        if (PR_HEAD.test(context)) {
          problems.push(`${label} fetches the pull request head`);
        }
      }
    });
  }
  return problems;
};

const names = readdirSync(new URL('../.github/workflows/', import.meta.url))
  .filter((file) => file.endsWith('.yml'))
  .map((file) => file.slice(0, -'.yml'.length))
  .sort();

test('pull_request_target workflows never check out or fetch pull request code', () => {
  const targets = names.filter((name) => isPullRequestTarget(workflow(name)));
  for (const name of [
    'ci-infrastructure-gate',
    'tracker-pr-issue-status',
    'tracker-pr-metadata',
  ]) {
    assert.ok(targets.includes(name), `${name} runs on pull_request_target`);
  }
  for (const name of targets) {
    assert.deepEqual(untrustedCode(workflow(name)), [], name);
  }
});

test('pull_request_target is found in string, list, and map triggers', () => {
  assert.ok(isPullRequestTarget(parse('on: pull_request_target')));
  assert.ok(isPullRequestTarget(parse('on: [push, pull_request_target]')));
  assert.ok(
    isPullRequestTarget(
      parse('on:\n  pull_request_target:\n    types: [opened]'),
    ),
  );
  assert.ok(!isPullRequestTarget(parse('on: [push, pull_request]')));
});

const target = (steps, extra = '') =>
  parse(
    `on: pull_request_target\n${extra}jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`,
  );
const checkout = (inputs) =>
  `      - name: Check out\n        uses: actions/checkout@0000000000000000000000000000000000000000 # v4\n        with:\n${inputs}`;

test('a checkout of the pull request head fails', () => {
  for (const ref of [
    '${{ github.event.pull_request.head.sha }}',
    '${{ github.event.pull_request.head.ref }}',
    '${{ github.head_ref }}',
    'refs/pull/${{ github.event.pull_request.number }}/merge',
  ]) {
    assert.deepEqual(
      untrustedCode(target(checkout(`          ref: ${ref}\n`))),
      [`build step 1 (Check out) checks out the pull request head: ${ref}`],
      ref,
    );
  }
});

test('a checkout of another repository fails', () => {
  const repository = '${{ github.event.pull_request.head.repo.full_name }}';
  assert.deepEqual(
    untrustedCode(target(checkout(`          repository: ${repository}\n`))),
    [
      `build step 1 (Check out) checks out a repository other than the base repository: ${repository}`,
    ],
  );
  assert.equal(
    untrustedCode(target(checkout('          repository: someone/fork\n')))
      .length,
    1,
  );
});

test('a checkout of the default branch in the base repository passes', () => {
  for (const repository of [
    '${{ github.repository }}',
    '${{github.event.repository.full_name}}',
    'samlevin/mcc-stats-suite',
  ]) {
    assert.deepEqual(
      untrustedCode(
        target(
          checkout(
            `          ref: \${{ github.event.repository.default_branch }}\n          repository: ${repository}\n          persist-credentials: false\n`,
          ),
        ),
      ),
      [],
      repository,
    );
  }
});

test('a run step that fetches the pull request head fails', () => {
  const run = (script, env = '') =>
    `      - name: Fetch\n${env}        run: ${script}\n`;
  for (const steps of [
    run('git fetch origin pull/${{ github.event.pull_request.number }}/head'),
    run('git fetch origin ${{ github.event.pull_request.head.sha }}'),
    run('git -C repo fetch origin refs/pull/1/head'),
    run(
      'git fetch origin "$HEAD_SHA"',
      '        env:\n          HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n',
    ),
  ]) {
    assert.deepEqual(
      untrustedCode(target(steps)),
      ['build step 1 (Fetch) fetches the pull request head'],
      steps,
    );
  }
  assert.deepEqual(untrustedCode(target(run('git fetch origin main'))), []);
});

test('the same steps pass outside pull_request_target', () => {
  const definition = target(
    checkout('          ref: ${{ github.event.pull_request.head.sha }}\n'),
  );
  definition.on = 'pull_request';
  assert.deepEqual(untrustedCode(definition), []);
});
