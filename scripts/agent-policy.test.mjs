import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  binding,
  check,
  generate,
  loadPolicy,
  parseReviewReport,
  parseSource,
  placeholders,
  prefix,
  publishReview,
  render,
  renderBody,
  renderRole,
  renderWorkflow,
  resolve,
  reviewEvent,
  REVIEW_VERDICTS,
  substitute,
  TOOLS,
} from './agent-policy.mjs';

const policy = loadPolicy();
const PREFIX = prefix(policy);
// The same policy bound to another repository with no CI-applied infrastructure.
const other = {
  ...policy,
  binding: {
    namespace: 'other',
    label: 'Other',
    repository: 'example/other',
    project: { owner: 'example', number: 7, name: 'Other delivery' },
    docs: { triage: 'TRIAGE.md', workflow: 'AGENTS.md', guides: ['AGENTS.md'] },
    features: { infrastructure: false },
  },
};

test('missing and unknown commands show an actionable error and combined help', () => {
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [new URL('./agent-policy.mjs', import.meta.url).pathname, ...args],
      { encoding: 'utf8' },
    );
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.equal(help.stderr, '');
  for (const option of [
    '--tool',
    '--role',
    '--pr',
    '--base',
    '--head',
    '--report',
  ])
    assert.ok(help.stdout.includes(option), option);
  for (const [args, message] of [
    [[], 'Name a command'],
    [['unknown'], 'Unknown command unknown'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${message}\n\n${help.stdout}`);
  }
});

test('the binding resolves every placeholder and feature section', () => {
  assert.equal(PREFIX, `${policy.binding.namespace}-`);
  assert.deepEqual(placeholders(other), {
    prefix: 'other-',
    label: 'Other',
    repository: 'example/other',
    'project.owner': 'example',
    'project.number': '7',
    'project.name': 'Other delivery',
    'project.url': 'https://github.com/users/example/projects/7',
    'docs.triage': 'TRIAGE.md',
    'docs.workflow': 'AGENTS.md',
    'docs.guides': '`AGENTS.md`',
  });
  assert.equal(
    placeholders({
      ...other,
      binding: {
        ...other.binding,
        docs: { ...other.binding.docs, guides: ['A.md', 'B.md', 'C.md'] },
      },
    })['docs.guides'],
    '`A.md`, `B.md`, or `C.md`',
  );
  const text =
    'Spawn {{prefix}}implementer in {{repository}}{{#infrastructure}} (infra){{/infrastructure}}.';
  assert.equal(
    substitute(text, policy),
    `Spawn ${PREFIX}implementer in ${policy.binding.repository}${
      policy.binding.features.infrastructure ? ' (infra)' : ''
    }.`,
  );
  assert.equal(
    substitute(text, other),
    'Spawn other-implementer in example/other.',
  );
  assert.throws(
    () => substitute('{{nope}}', policy),
    /Unknown placeholder: nope/,
  );
  assert.equal(substitute('a \\{{prefix}} b', policy), 'a {{prefix}} b');
  assert.throws(
    () => substitute('{{#magic}}x{{/magic}}', policy),
    /Unknown feature section: magic/,
  );
  assert.throws(
    () => substitute('{{#infrastructure}}x', policy),
    /Unbalanced feature section/,
  );
  assert.throws(
    () => binding({ ...policy, binding: undefined }),
    /missing binding/,
  );
  assert.throws(
    () =>
      binding({
        ...policy,
        binding: { ...policy.binding, namespace: 'Bad-Name' },
      }),
    /namespace must be lowercase/,
  );
  assert.throws(
    () =>
      binding({
        ...policy,
        binding: { ...policy.binding, project: { owner: 'x', name: 'y' } },
      }),
    /missing project.number/,
  );
});

test('worktree ignores preserve tracked agent definitions and configuration', () => {
  const gitignore = readFileSync(
    new URL('../.gitignore', import.meta.url),
    'utf8',
  ).split(/\r?\n/);
  const worktrees = ['.claude/worktrees/', '.codex/worktrees/'];
  for (const path of worktrees)
    assert.ok(gitignore.includes(path), `missing .gitignore entry: ${path}`);

  const probes = worktrees.map((path) => `${path}ignore-probe`);
  const definitions = [...render().keys()].filter((path) =>
    /^\.(claude|codex)\//.test(path),
  );
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: new URL('..', import.meta.url),
    input: [...probes, ...definitions, '.codex/config.toml'].join('\n') + '\n',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), probes);
});

test('generated output carries no unresolved placeholder and follows the binding', () => {
  for (const [path, content] of render()) {
    // The maintainer skill documents the placeholders literally.
    if (!path.includes(`/${PREFIX}agents/`))
      assert.doesNotMatch(content, /\{\{/, path);
    assert.ok(path.includes(`/${PREFIX}`), path);
  }
  const resolved = resolve(other, { tool: 'claude', role: 'implementer' });
  assert.equal(resolved.spawn.subagent_type, 'other-implementer');
});

test('every role and capability resolves to a supported setting for both tools', () => {
  for (const tool of TOOLS) {
    for (const role of Object.keys(policy.roles)) {
      const resolved = resolve(policy, { tool, role });
      assert.equal(resolved.source.model, 'policy');
      assert.equal(resolved.source.effort, 'policy');
      assert.ok(resolved.model);
      assert.ok(resolved.effort);
    }
    for (const capability of Object.keys(policy.capabilities))
      assert.ok(resolve(policy, { tool, capability }).model);
  }
});

test('capabilities have explicit, differentiated policies per tool', () => {
  const required = [
    'issue-creation',
    'issue-triage',
    'implementation',
    'code-review',
    'security-review',
  ];
  for (const capability of required)
    for (const tool of TOOLS)
      assert.ok(policy.capabilities[capability][tool].model, capability);
  for (const tool of TOOLS) {
    const settings = new Set(
      required.map((capability) => {
        const entry = policy.capabilities[capability][tool];
        return `${entry.model}/${entry.effort}`;
      }),
    );
    assert.ok(settings.size > 1, `${tool} policy is undifferentiated`);
  }
});

test('a prompt override replaces only the named setting', () => {
  const base = resolve(policy, { tool: 'claude', role: 'implementer' });
  const modelOnly = resolve(policy, {
    tool: 'claude',
    role: 'implementer',
    model: 'sonnet',
  });
  assert.equal(modelOnly.model, 'sonnet');
  assert.equal(modelOnly.effort, base.effort);
  assert.deepEqual(modelOnly.source, { model: 'override', effort: 'policy' });
  const effortOnly = resolve(policy, {
    tool: 'codex',
    role: 'code-reviewer',
    effort: 'xhigh',
  });
  assert.equal(
    effortOnly.model,
    policy.capabilities['code-review'].codex.model,
  );
  assert.equal(effortOnly.effort, 'xhigh');
  assert.deepEqual(effortOnly.source, { model: 'policy', effort: 'override' });
  const both = resolve(policy, {
    tool: 'codex',
    role: 'implementer',
    model: 'gpt-6-sol',
    effort: 'ultra',
  });
  assert.deepEqual(both.spawn, {
    agent_type: `${PREFIX}implementer`,
    model: 'gpt-6-sol',
    reasoning_effort: 'ultra',
    fork_turns: 'none',
  });
});

test('spawn parameters use each tool vocabulary and the namespaced agent', () => {
  const claude = resolve(policy, { tool: 'claude', role: 'security-reviewer' });
  assert.deepEqual(claude.spawn, {
    subagent_type: `${PREFIX}security-reviewer`,
    model: claude.model,
    effort: claude.effort,
  });
  const codex = resolve(policy, { tool: 'codex', role: 'security-reviewer' });
  assert.equal(codex.spawn.agent_type, `${PREFIX}security-reviewer`);
  assert.equal(codex.spawn.reasoning_effort, codex.effort);
  assert.equal(codex.spawn.fork_turns, 'none');
  assert.equal(
    resolve(policy, { tool: 'claude', capability: 'issue-creation' }).spawn
      .subagent_type,
    null,
  );
});

test('unsupported models and efforts fail instead of falling back', () => {
  assert.throws(
    () =>
      resolve(policy, {
        tool: 'claude',
        role: 'implementer',
        model: 'gpt-6-luna',
      }),
    /Unsupported claude model "gpt-6-luna"/,
  );
  assert.throws(
    () =>
      resolve(policy, { tool: 'codex', role: 'implementer', model: 'opus' }),
    /Unsupported codex model "opus"/,
  );
  assert.throws(
    () =>
      resolve(policy, { tool: 'claude', role: 'implementer', effort: 'ultra' }),
    /Unsupported claude effort "ultra"/,
  );
  assert.throws(
    () =>
      resolve(policy, {
        tool: 'codex',
        role: 'implementer',
        model: 'gpt-6-luna',
        effort: 'ultra',
      }),
    /Unsupported codex effort "ultra" for model "gpt-6-luna"/,
  );
  assert.throws(
    () => resolve(policy, { tool: 'cursor', role: 'implementer' }),
    /Unknown tool/,
  );
  assert.throws(
    () => resolve(policy, { tool: 'claude', role: 'reviewer' }),
    /Unknown role/,
  );
  assert.throws(
    () => resolve(policy, { tool: 'claude', capability: 'deploy' }),
    /Unknown capability/,
  );
});

test('a full Claude model ID is accepted with the shared effort levels', () => {
  const resolved = resolve(policy, {
    tool: 'claude',
    role: 'code-reviewer',
    model: 'claude-opus-5-5',
    effort: 'max',
  });
  assert.equal(resolved.model, 'claude-opus-5-5');
  assert.throws(
    () =>
      resolve(policy, {
        tool: 'claude',
        role: 'code-reviewer',
        model: 'gpt-x',
      }),
    /Unsupported claude model/,
  );
});

const source = `---
name: sample
description: Sample role.
claude:
  tools: Read, Grep
  color: blue
codex:
  default_permissions: ":read-only"
---
Shared line.
<!-- claude-only -->
Claude line.
<!-- /claude-only -->
<!-- codex-only -->
Codex line.
<!-- /codex-only -->
Last shared line.
`;

test('tool-only blocks render for one tool and vanish for the other', () => {
  const { body } = parseSource(source);
  assert.equal(
    renderBody(body, 'claude'),
    'Shared line.\nClaude line.\nLast shared line.\n',
  );
  assert.equal(
    renderBody(body, 'codex'),
    'Shared line.\nCodex line.\nLast shared line.\n',
  );
});

test('a plain frontmatter value containing " #" is rejected, not truncated', () => {
  const truncated = `---
name: implement
description: Use for "implement #N" or an issue URL.
---
Body
`;
  assert.throws(
    () => parseSource(truncated),
    /Quote the frontmatter value of description/,
  );
  const quoted = truncated.replace(
    'description: Use for "implement #N" or an issue URL.',
    'description: "Use for \\"implement #N\\" or an issue URL."',
  );
  assert.equal(
    parseSource(quoted).meta.description,
    'Use for "implement #N" or an issue URL.',
  );
  assert.equal(
    parseSource(`---\nname: x\nargument-hint: <#N | URL>\n---\nBody\n`).meta[
      'argument-hint'
    ],
    '<#N | URL>',
  );
});

test('Claude agents pin the policy; Codex agents omit model and effort', () => {
  const sample = {
    ...policy,
    roles: { ...policy.roles, sample: 'code-review' },
  };
  const claude = renderRole(sample, 'sample', source, 'claude');
  assert.match(claude, new RegExp(`^name: ${PREFIX}sample$`, 'm'));
  assert.match(claude, /^tools: Read, Grep$/m);
  assert.match(
    claude,
    new RegExp(
      `^model: ${policy.capabilities['code-review'].claude.model}$`,
      'm',
    ),
  );
  assert.match(
    claude,
    new RegExp(
      `^effort: ${policy.capabilities['code-review'].claude.effort}$`,
      'm',
    ),
  );
  assert.match(claude, /Claude line\./);
  assert.doesNotMatch(claude, /Codex line\./);
  const codex = renderRole(sample, 'sample', source, 'codex');
  assert.match(codex, new RegExp(`^name = "${PREFIX}sample"$`, 'm'));
  assert.match(codex, /^default_permissions = ":read-only"$/m);
  assert.doesNotMatch(codex, /^model/m);
  assert.doesNotMatch(codex, /^model_reasoning_effort/m);
  assert.match(codex, /Codex line\./);
  assert.doesNotMatch(codex, /Claude line\./);
  assert.match(codex, /developer_instructions = '''\n[\s\S]*'''\n$/);
});

test('workflows become a Claude skill and a Codex skill with a manifest', () => {
  const workflow = `---
name: sample
description: Sample workflow.
argument-hint: "[target]"
capability: issue-creation
claude:
  disable-model-invocation: true
codex:
  display_name: "MCC: Sample"
  allow_implicit_invocation: false
---
Body.
`;
  const claude = renderWorkflow(policy, 'sample', workflow, 'claude');
  assert.deepEqual(Object.keys(claude), ['SKILL.md']);
  assert.match(claude['SKILL.md'], new RegExp(`^name: ${PREFIX}sample$`, 'm'));
  assert.match(claude['SKILL.md'], /^argument-hint: '\[target\]'$/m);
  assert.match(claude['SKILL.md'], /^disable-model-invocation: true$/m);
  assert.match(
    claude['SKILL.md'],
    new RegExp(
      `^model: ${policy.capabilities['issue-creation'].claude.model}$`,
      'm',
    ),
  );
  const codex = renderWorkflow(policy, 'sample', workflow, 'codex');
  assert.deepEqual(Object.keys(codex).sort(), [
    'SKILL.md',
    'agents/openai.yaml',
  ]);
  assert.match(codex['SKILL.md'], new RegExp(`^name: ${PREFIX}sample$`, 'm'));
  assert.doesNotMatch(codex['SKILL.md'], /^model:/m);
  assert.match(codex['agents/openai.yaml'], /display_name: 'MCC: Sample'/);
  assert.match(codex['agents/openai.yaml'], /allow_implicit_invocation: false/);
});

test('every role and workflow renders for both tools with matching bodies', () => {
  const files = render();
  const names = [...files.keys()];
  for (const role of Object.keys(policy.roles)) {
    assert.ok(names.includes(`.claude/agents/${PREFIX}${role}.md`), role);
    assert.ok(names.includes(`.codex/agents/${PREFIX}${role}.toml`), role);
  }
  for (const skill of [
    'agents',
    'implement',
    'create-github-issue',
    'review-code',
    'review-security',
    'plain-language',
    'stack',
  ]) {
    assert.ok(
      names.includes(`.claude/skills/${PREFIX}${skill}/SKILL.md`),
      skill,
    );
    assert.ok(
      names.includes(`.agents/skills/${PREFIX}${skill}/SKILL.md`),
      skill,
    );
    assert.ok(
      names.includes(`.agents/skills/${PREFIX}${skill}/agents/openai.yaml`),
      skill,
    );
  }
  // Shared references are copied into both skills byte for byte.
  assert.equal(
    files.get(
      `.claude/skills/${PREFIX}create-github-issue/references/github-operations.md`,
    ),
    files.get(
      `.agents/skills/${PREFIX}create-github-issue/references/github-operations.md`,
    ),
  );
  // Tool-only blocks aside, the two renderings of a source are the same text:
  // every shared line of every role, workflow, and Markdown reference appears
  // in both tools' output.
  for (const [source, outputs] of sourcePairs()) {
    const text = substitute(
      readFileSync(new URL(`../${source}`, import.meta.url), 'utf8'),
      policy,
    );
    const body = source.includes('/references/')
      ? text
      : parseSource(text).body;
    for (const line of sharedLines(body))
      for (const output of outputs)
        assert.ok(
          files.get(output).includes(line),
          `${output}: ${line.slice(0, 60)}`,
        );
  }
});

// Each canonical source with its Claude Code and Codex renderings.
function sourcePairs() {
  const pairs = [];
  for (const role of Object.keys(policy.roles))
    pairs.push([
      `.agents/roles/${role}.md`,
      [
        `.claude/agents/${PREFIX}${role}.md`,
        `.codex/agents/${PREFIX}${role}.toml`,
      ],
    ]);
  for (const path of render().keys()) {
    const match = path.match(
      new RegExp(`^\\.claude/skills/${PREFIX}([^/]+)/(.+\\.md)$`),
    );
    if (!match) continue;
    const [, skill, file] = match;
    pairs.push([
      file === 'SKILL.md'
        ? `.agents/workflows/${skill}.md`
        : `.agents/workflows/${skill}/${file}`,
      [path, `.agents/skills/${PREFIX}${skill}/${file}`],
    ]);
  }
  return pairs;
}

// The non-empty lines outside every tool-only block. Codex TOML keeps the
// text verbatim, so the same lines must appear in both renderings.
function sharedLines(body) {
  return body
    .replace(/<!-- (claude|codex)-only -->\n[\s\S]*?<!-- \/\1-only -->\n?/g, '')
    .split('\n')
    .filter((line) => line.trim());
}

// Report and relay wording that callers depend on. Each check matches a short
// phrase on one rendered line, so rewording elsewhere does not break it.
const lineWith = (content, ...phrases) =>
  content
    .split('\n')
    .find((line) =>
      phrases.every((phrase) =>
        typeof phrase === 'string' ? line.includes(phrase) : phrase.test(line),
      ),
    );

test('caller skills relay the agent result verbatim in both tools', () => {
  const files = render();
  for (const skill of ['implement', 'review-code', 'review-security'])
    for (const path of [
      `.claude/skills/${PREFIX}${skill}/SKILL.md`,
      `.agents/skills/${PREFIX}${skill}/SKILL.md`,
    ])
      assert.ok(
        lineWith(
          files.get(path),
          /\b(relay|print)\b/i,
          'Requested settings:',
          /\bverbatim\b/,
        ),
        `${path} must relay the result and its Requested settings line verbatim`,
      );
});

test('every role reports its requested settings in both tools', () => {
  const files = render();
  for (const role of Object.keys(policy.roles))
    for (const path of [
      `.claude/agents/${PREFIX}${role}.md`,
      `.codex/agents/${PREFIX}${role}.toml`,
    ])
      assert.ok(
        files.get(path).includes('Requested settings: Policy:'),
        `${path} must return a Requested settings: Policy: line`,
      );
});

// The leaf delivery procedure that the main thread and an isolated
// implementer both follow, in each tool's package.
const DELIVERY = [
  `.claude/skills/${PREFIX}implement/references/delivery.md`,
  `.agents/skills/${PREFIX}implement/references/delivery.md`,
];
const QUEUE = DELIVERY.map((path) => path.replace('delivery.md', 'queue.md'));
const IMPLEMENT = [
  `.claude/skills/${PREFIX}implement/SKILL.md`,
  `.agents/skills/${PREFIX}implement/SKILL.md`,
];
const STACK = [
  `.claude/skills/${PREFIX}stack/SKILL.md`,
  `.agents/skills/${PREFIX}stack/SKILL.md`,
];

// The text under one `## ` heading of a rendered Markdown file.
function section(content, heading) {
  const start = content.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const end = content.indexOf('\n## ', start + 1);
  return content.slice(start, end === -1 ? undefined : end);
}

test('the delivery owner sends the reviewer its own resolved policy line', () => {
  const files = render();
  for (const path of DELIVERY)
    assert.ok(
      lineWith(
        files.get(path),
        'review_mode=pre_pr',
        'resolved `Policy:` line',
        'role=code-reviewer',
      ),
      `${path} pre-PR packet must carry the reviewer's resolved Policy: line`,
    );
});

test('the delivery owner never sets In review and reports the state as read', () => {
  const files = render();
  for (const path of DELIVERY) {
    const content = files.get(path);
    assert.ok(
      lineWith(content, /^Never:/, 'In review or Done'),
      `${path} must forbid setting In review or Done`,
    );
    assert.ok(
      lineWith(
        section(content, 'Claim'),
        'In progress is the only project status you ever set',
      ),
      `${path} claim step must limit the agent to In progress`,
    );
    assert.ok(
      lineWith(section(content, 'PR'), "Leave the issue's status alone"),
      `${path} PR step must leave In review to automation`,
    );
    assert.ok(
      lineWith(content, /^Return /, 'project state as read'),
      `${path} handoff must report the project state as read`,
    );
    assert.doesNotMatch(content, /Move the issue to In review/i, path);
  }
});

test('removed coordination roles cannot be selected through any entry point', () => {
  assert.deepEqual(Object.keys(policy.roles).sort(), [
    'code-reviewer',
    'implementer',
    'issue-triager',
    'security-reviewer',
  ]);
  for (const capability of ['orchestration', 'stack-management'])
    assert.equal(policy.capabilities[capability], undefined, capability);
  for (const tool of TOOLS)
    for (const role of ['orchestrator', 'stack-manager'])
      assert.throws(
        () => resolve(policy, { tool, role }),
        /Unknown role/,
        `${tool} ${role}`,
      );
  const files = render();
  const agents = [...files.keys()].filter((path) =>
    /^\.(claude|codex)\/agents\//.test(path),
  );
  assert.deepEqual(
    agents.sort(),
    Object.keys(policy.roles)
      .flatMap((role) => [
        `.claude/agents/${PREFIX}${role}.md`,
        `.codex/agents/${PREFIX}${role}.toml`,
      ])
      .sort(),
  );
  for (const [path, content] of files)
    assert.doesNotMatch(
      content,
      new RegExp(`${PREFIX}(orchestrator|stack-manager)\\b`),
      path,
    );
  // The CLI refuses the removed roles as well.
  for (const role of ['orchestrator', 'stack-manager']) {
    const result = spawnSync(
      process.execPath,
      [
        new URL('./agent-policy.mjs', import.meta.url).pathname,
        'resolve',
        '--tool',
        'claude',
        '--role',
        role,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1, role);
    assert.match(result.stderr, /Unknown role/, role);
  }
});

test('the implement entry point delivers a leaf inline by default in both tools', () => {
  const files = render();
  for (const path of IMPLEMENT) {
    const content = files.get(path);
    assert.ok(
      lineWith(content, 'You are the delivery owner', 'in this thread'),
      `${path} must make the invoking thread the owner`,
    );
    assert.ok(
      lineWith(
        content,
        /^\| Leaf issue \|/,
        'inline in this thread',
        'references/delivery.md',
      ),
      `${path} must route a leaf inline to the delivery procedure`,
    );
    assert.ok(
      lineWith(
        content,
        /^\| PR rework \|/,
        'inline in this thread',
        'references/delivery.md',
      ),
      `${path} must route PR rework inline`,
    );
    assert.ok(
      lineWith(
        content,
        /^\| Container or epic \|/,
        'sequential dependency queue in this thread',
        'references/queue.md',
      ),
      `${path} must route a container to the queue in this thread`,
    );
    // An implementer is spawned only from the exception section.
    const exception = section(content, 'Isolated implementer exception');
    for (const heading of ['Resolve the target', 'Pick the mode', 'Report'])
      assert.doesNotMatch(
        section(content, heading),
        /subagent_type|spawn_agent/,
        `${path} ${heading}`,
      );
    assert.match(exception, /By default you deliver the work yourself/);
    assert.match(exception, /never spawns another implementer/);
    // Inline skills cannot change the session model, and say so.
    assert.ok(
      lineWith(
        section(content, 'Settings'),
        'cannot change them',
        'Advisory policy:',
      ),
      `${path} must report the main-thread policy as advisory`,
    );
    assert.doesNotMatch(content, /^model:/m, path);
  }
  const [claude, codex] = IMPLEMENT.map((path) =>
    section(files.get(path), 'Isolated implementer exception'),
  );
  assert.match(claude, new RegExp(`subagent_type: ${PREFIX}implementer`));
  assert.match(codex, /fork_turns: "none"/);
  assert.doesNotMatch(claude, /spawn_agent/);
  assert.doesNotMatch(codex, /subagent_type/);
});

test('a container runs as a dependency queue in the owning thread', () => {
  const files = render();
  for (const path of QUEUE) {
    const content = files.get(path);
    assert.ok(lineWith(content, 'No separate orchestrator agent'), path);
    assert.ok(lineWith(content, 'Detect cycles in the blocked-by edges'), path);
    assert.ok(lineWith(content, '`resume`', 'Reuse its pushed branch'), path);
    assert.ok(lineWith(content, '`waiting`', 'blocker is unmet'), path);
    assert.ok(
      lineWith(
        content,
        'Delivery is sequential by default',
        'record its result',
        'before you start the next leaf',
      ),
      `${path} must deliver one leaf at a time and record each result`,
    );
    const parallel = section(content, 'Parallel exception');
    assert.match(parallel, /explicitly asked for parallel delivery/);
    assert.match(parallel, /different groups/);
    assert.match(parallel, /no overlapping files or shared contracts/);
    assert.match(parallel, /At most one leaf per group runs at a time/);
    assert.match(parallel, /Never infer, form, extend, or merge groups/);
    // Each concurrent implementer learns what the other running leaves own.
    assert.ok(
      lineWith(
        parallel,
        'carries an `Owned by other running leaves:` field',
        'issue numbers of the other leaves',
        'files and shared contracts',
      ),
      `${path} must hand each concurrent leaf the other leaves' ownership`,
    );
    // Resume checks out the existing branch instead of creating it.
    assert.ok(
      lineWith(content, '`resume`', 'git worktree add <path> <branch>'),
      `${path} must check out the existing branch on resume`,
    );
    // A claim whose worktree is missing here is never taken over silently.
    assert.ok(
      lineWith(content, '`resume`', '`git worktree list`'),
      `${path} must tie resume to a worktree in this checkout`,
    );
    assert.ok(
      lineWith(content, 'whose worktree is missing here', 'Ask the person'),
      `${path} must treat a missing worktree as owned elsewhere`,
    );
  }
  // Concurrent leaves really run at the same time in each tool.
  assert.match(
    section(files.get(QUEUE[0]), 'Parallel exception'),
    /sending their Agent calls together in one message/,
  );
  assert.match(
    section(files.get(QUEUE[1]), 'Parallel exception'),
    /`spawn_agent` returns at once/,
  );
  const creation = readFileSync(
    new URL('../.agents/issue-creation.md', import.meta.url),
    'utf8',
  );
  assert.ok(
    lineWith(creation, `${PREFIX}implement\` reads only the lines`),
    'issue-creation.md must name the queue as the record reader',
  );
});

test('the delivery owner runs stack operations itself through the shared stack skill', () => {
  const files = render();
  for (const path of DELIVERY)
    assert.ok(
      lineWith(
        section(files.get(path), 'Stack'),
        `Run every stack operation yourself with the ${PREFIX}stack skill`,
        'in the worktree you created',
      ),
      path,
    );
  assert.match(
    section(files.get(DELIVERY[0]), 'Stack'),
    new RegExp(`Skill tool \\(\`${PREFIX}stack\`\\)`),
  );
  assert.match(
    section(files.get(DELIVERY[1]), 'Stack'),
    new RegExp(`\\$${PREFIX}stack`),
  );
  for (const path of STACK) {
    const content = files.get(path);
    assert.ok(
      lineWith(content, 'You run this skill yourself', 'worktree you created'),
      path,
    );
    assert.match(content, /git worktree list --porcelain/, path);
    const never = section(content, 'Never run');
    for (const phrase of [
      '`gh stack sync`',
      '`gh stack rebase`',
      '`--no-trunk`',
      '`gh stack push`',
      '`gh stack submit`',
      'rebase.updateRefs=false',
      'bare `git push --force`',
    ])
      assert.ok(never.includes(phrase), `${path} never runs: ${phrase}`);
    assert.ok(
      lineWith(never, '`gh stack push`', 'fetch', 'previously verified SHA'),
      `${path} must explain why the stack push lease is unsafe`,
    );
    const operations = section(content, 'Operations');
    assert.match(
      operations,
      /git -c rebase\.updateRefs=false rebase --onto/,
      path,
    );
    assert.match(
      operations,
      /--force-with-lease=<branch>:<expected SHA>/,
      path,
    );
    assert.match(operations, /gh stack link --base main <PR URL>/, path);
    assert.match(operations, /Never adopt, rebase, or push the prerequisite/);
    // Rework and resume of an earlier delivery's branch have working paths.
    assert.ok(
      lineWith(content, 'earlier delivery', 'head branch of the target PR'),
      `${path} must define ownership for rework and resume`,
    );
    assert.match(
      operations,
      /rebase\.updateRefs=false rebase --onto <new parent head> <old parent head>`, then push with `git push --force-with-lease=<branch>:<verified remote head> origin HEAD:<branch>`/,
      path,
    );
    assert.match(operations, /`git worktree add <path> <branch>`/, path);
    assert.ok(
      lineWith(content, 'Authority:', 'never covers merges'),
      `${path} must not authorize merges`,
    );
  }
});

test('independent review stays a separate fresh-context gate on mandatory paths', () => {
  const files = render();
  for (const path of DELIVERY) {
    const review = section(files.get(path), 'Pre-PR review');
    for (const scope of [
      '`.agents/`',
      '`AGENTS.md`',
      '`scripts/agent-policy*`',
      '`infrastructure/`',
      '`.terrateam/`',
      '`.github/workflows/`',
      'CDK account or environment checks',
    ])
      assert.ok(
        lineWith(review, 'always required', scope),
        `${path}: ${scope}`,
      );
    assert.match(review, new RegExp(`fresh ${PREFIX}code-reviewer`));
    assert.match(review, /Leave out your self-assessment/);
    assert.match(review, /exact base\/head pair/);
    assert.match(review, /After two rejected rounds, return BLOCKED/);
    assert.match(review, /Never self-approve/);
    assert.ok(
      lineWith(files.get(path), 'Once a PR exists, never invoke'),
      `${path} must keep requested review separate from pre-PR review`,
    );
    assert.ok(
      lineWith(files.get(path), /^Never:/, `${PREFIX}security-reviewer`),
      `${path} must never start a security review`,
    );
  }
  assert.match(
    files.get(`.claude/skills/${PREFIX}review-security/SKILL.md`),
    /^disable-model-invocation: true$/m,
  );
  assert.match(
    files.get(`.agents/skills/${PREFIX}review-security/agents/openai.yaml`),
    /allow_implicit_invocation: false/,
  );
});

test('an isolated implementer follows the shared procedure and delegates nothing else', () => {
  const files = render();
  const claude = files.get(`.claude/agents/${PREFIX}implementer.md`);
  const codex = files.get(`.codex/agents/${PREFIX}implementer.toml`);
  assert.match(claude, /^isolation: worktree$/m);
  assert.match(
    claude,
    new RegExp(
      `git show origin/main:\\.claude/skills/${PREFIX}implement/references/delivery\\.md`,
    ),
  );
  assert.match(
    codex,
    new RegExp(
      `git show origin/main:\\.agents/skills/${PREFIX}implement/references/delivery\\.md`,
    ),
  );
  for (const content of [claude, codex]) {
    assert.ok(lineWith(content, 'Never spawn another implementer'));
    assert.ok(lineWith(content, 'BLOCKED: container'));
    assert.ok(
      lineWith(content, '`Owned by other running leaves:`', 'return BLOCKED'),
    );
  }
});

test('issue filing classifies inline and reserves the triager for independent judgment', () => {
  const files = render();
  for (const path of [
    `.claude/skills/${PREFIX}create-github-issue/SKILL.md`,
    `.agents/skills/${PREFIX}create-github-issue/SKILL.md`,
  ]) {
    const triage = section(files.get(path), 'Triage');
    assert.match(triage, /Classify inline by default/);
    for (const reason of [
      '- Classification:',
      '- Decomposition:',
      '- Dependency judgment:',
    ])
      assert.ok(triage.includes(reason), `${path}: ${reason}`);
    assert.match(triage, /Only the triager forms independence groups/);
  }
});

// Routing facts: the namespaced agents and skills a file names and the
// references it links. Both tools' renderings of one source must agree.
function routing(content) {
  return [
    ...new Set(
      [
        ...content.matchAll(
          new RegExp(
            `${PREFIX}[a-z]+(?:-[a-z]+)*|references/[a-z-]+\\.md`,
            'g',
          ),
        ),
      ].map((match) => match[0]),
    ),
  ].sort();
}

test('both tools route every source to the same agents, skills, and references', () => {
  const files = render();
  for (const [source, [claude, codex]] of sourcePairs())
    assert.deepEqual(
      routing(files.get(claude)),
      routing(files.get(codex)),
      source,
    );
  // The delivery result fields match word for word.
  const [claudeResult, codexResult] = DELIVERY.map((path) =>
    lineWith(files.get(path), /^Return READY FOR REVIEW or BLOCKED/),
  );
  assert.ok(claudeResult);
  assert.equal(claudeResult, codexResult);
});

test('the README keeps the effective-model verification row', () => {
  const readme = readFileSync(
    new URL('../.agents/README.md', import.meta.url),
    'utf8',
  );
  assert.ok(
    lineWith(
      readme,
      /^\|/,
      'Effective-model verification',
      'sqlite3',
      'state_5.sqlite',
    ),
    'README must keep the effective-model verification row with the Codex sqlite3 check',
  );
});

// Manual review publication against mocked `gh api` calls. Nothing here
// reaches GitHub. `run` stands in for execFileSync and records every call.
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const report = (verdict, pair = `${BASE}..${HEAD}`) =>
  [
    `Verdict: ${verdict}`,
    `Base/Head: ${pair}`,
    'Acceptance: criterion one met',
    'Findings: high | scripts/x.mjs:1 | problem | fix',
    'Limits: tests read, not run.',
    'Requested settings: Policy: tool=claude role=code-reviewer model=opus effort=high (model: policy, effort: policy)',
  ].join('\n');

// A `gh api` failure: GitHub's JSON body on stdout, the HTTP summary on stderr.
function ghFailure(status, body) {
  return Object.assign(new Error('gh failed'), {
    status: 1,
    stdout: JSON.stringify(body),
    stderr: `gh: ${body.message} (HTTP ${status})\n`,
  });
}

function mockGitHub({
  viewer = 'reviewer',
  author = 'author',
  base = BASE,
  head = HEAD,
  user,
  review,
} = {}) {
  const calls = [];
  const posts = [];
  const run = (command, args, options) => {
    assert.equal(command, 'gh');
    calls.push(args);
    const path = args[1];
    if (path === `repos/${policy.binding.repository}/pulls/7`)
      return JSON.stringify({
        number: 7,
        user: author === null ? null : { login: author },
        base: { sha: base },
        head: { sha: head },
      });
    if (path === 'user') {
      if (user) throw user;
      return JSON.stringify(viewer === null ? {} : { login: viewer });
    }
    if (path === `repos/${policy.binding.repository}/pulls/7/reviews`) {
      assert.deepEqual(args.slice(2), ['--method', 'POST', '--input', '-']);
      const payload = JSON.parse(options.input);
      posts.push(payload);
      if (review) throw review;
      return JSON.stringify({
        id: 1,
        html_url: 'https://github.com/example/pull/7#pullrequestreview-1',
      });
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { run, calls, posts };
}

const publish = (verdict, github, options = {}) =>
  publishReview(
    policy,
    {
      pr: '7',
      base: BASE,
      head: HEAD,
      report: report(verdict),
      ...options,
    },
    github.run,
  );

test('a review report yields its verdict and reviewed SHAs', () => {
  assert.deepEqual(parseReviewReport(report('REQUEST CHANGES')), {
    verdict: 'REQUEST CHANGES',
    base: BASE,
    head: HEAD,
  });
  assert.deepEqual(
    parseReviewReport('**Verdict:** APPROVE\n- Base/Head: `abc1234..def5678`'),
    { verdict: 'APPROVE', base: 'abc1234', head: 'def5678' },
  );
  assert.deepEqual(
    parseReviewReport('Verdict: BLOCKED\nBase/Head: abc1234 .. def5678'),
    { verdict: 'BLOCKED', base: 'abc1234', head: 'def5678' },
  );
  for (const text of [
    'Verdict: BLOCKED',
    'Verdict: BLOCKED\nBase/Head: unknown',
    'Verdict: BLOCKED\nBase/Head: abc1234',
  ])
    assert.throws(
      () => parseReviewReport(text),
      /Review not posted: the report has no Base\/Head: <sha>\.\.<sha> line/,
    );
  assert.throws(
    () => parseReviewReport('Findings: none'),
    /Review not posted: the report has no Verdict: line/,
  );
  assert.throws(
    () => parseReviewReport('Verdict: APPROVE\nVerdict: REQUEST CHANGES'),
    /conflicting verdicts/,
  );
});

test('only a change request from another account requests changes, and nothing approves', () => {
  for (const verdict of REVIEW_VERDICTS) {
    const other = reviewEvent({ verdict, viewer: 'bob', author: 'alice' });
    assert.equal(
      other.event,
      verdict === 'REQUEST CHANGES' ? 'REQUEST_CHANGES' : 'COMMENT',
      verdict,
    );
    // Logins compare as GitHub does, whatever agent or model is reviewing.
    const same = reviewEvent({ verdict, viewer: 'Alice', author: 'alice' });
    assert.equal(same.event, 'COMMENT', verdict);
    const unknown = reviewEvent({
      verdict,
      viewer: null,
      author: 'alice',
      identityError: 'HTTP 403',
    });
    assert.equal(unknown.event, 'COMMENT', verdict);
    assert.match(unknown.note, /could not be compared.*HTTP 403/);
  }
  assert.match(
    reviewEvent({ verdict: 'REQUEST CHANGES', viewer: 'a', author: 'a' }).note,
    /rather than a change request.*share the GitHub account @a/,
  );
  assert.match(
    reviewEvent({ verdict: 'APPROVE', viewer: 'a', author: 'b' }).note,
    /never submits a GitHub approval/,
  );
  assert.equal(
    reviewEvent({ verdict: 'BLOCKED', viewer: 'a', author: 'b' }).note,
    null,
  );
  assert.throws(
    () => reviewEvent({ verdict: 'LGTM', viewer: 'a', author: 'b' }),
    /Unknown review verdict/,
  );
});

test('every manual PR review posts exactly one review with the right event', () => {
  const cases = [
    ['REQUEST CHANGES', 'reviewer', 'author', 'REQUEST_CHANGES'],
    ['APPROVE', 'reviewer', 'author', 'COMMENT'],
    ['BLOCKED', 'reviewer', 'author', 'COMMENT'],
    ['REQUEST CHANGES', 'samelogin', 'SameLogin', 'COMMENT'],
    ['APPROVE', 'samelogin', 'samelogin', 'COMMENT'],
    ['BLOCKED', 'samelogin', 'samelogin', 'COMMENT'],
  ];
  for (const [verdict, viewer, author, event] of cases) {
    const github = mockGitHub({ viewer, author });
    const result = publish(verdict, github);
    const label = `${verdict} ${viewer}/${author}`;
    assert.equal(github.posts.length, 1, label);
    const [payload] = github.posts;
    assert.equal(payload.event, event, label);
    assert.notEqual(payload.event, 'APPROVE', label);
    assert.equal(payload.commit_id, HEAD, label);
    assert.equal(result.event, event, label);
    assert.equal(result.posted, true, label);
    assert.match(result.url, /pullrequestreview-1$/, label);
    // The posted body carries the whole report and the reviewed pair.
    assert.ok(payload.body.includes(report(verdict)), label);
    assert.ok(payload.body.includes(`\`${BASE}..${HEAD}\``), label);
    if (verdict === 'REQUEST CHANGES' && event === 'COMMENT')
      assert.match(payload.body, /rather than a change request/, label);
  }
});

test('an unknown publishing identity posts a comment that says why', () => {
  const denied = () =>
    ghFailure(403, { message: 'Resource not accessible by integration' });
  for (const github of [
    mockGitHub({ user: denied() }),
    mockGitHub({ viewer: null }),
    mockGitHub({ author: null }),
  ]) {
    const result = publish('REQUEST CHANGES', github);
    assert.equal(github.posts.length, 1);
    assert.equal(github.posts[0].event, 'COMMENT');
    assert.match(github.posts[0].body, /could not be compared/);
    assert.equal(result.event, 'COMMENT');
  }
  const github = mockGitHub({ user: denied() });
  publish('APPROVE', github);
  assert.match(
    github.posts[0].body,
    /HTTP 403: Resource not accessible by integration/,
  );
});

test('a failed submission is reported, never claimed as posted', () => {
  const rejected = mockGitHub({
    review: ghFailure(422, {
      message: 'Unprocessable Entity',
      errors: ['Review Can not request changes on your own pull request'],
    }),
  });
  assert.throws(
    () => publish('REQUEST CHANGES', rejected),
    (error) =>
      error.name === 'ReviewNotPosted' &&
      /^Review not posted: gh api \S+\/reviews failed: HTTP 422: Unprocessable Entity: Review Can not request changes on your own pull request\. Check the pull request/.test(
        error.message,
      ),
  );
  assert.equal(rejected.posts.length, 1);
  const wrap = (override) => {
    const github = mockGitHub();
    return {
      github,
      run: (command, args, options) =>
        override(args) ?? github.run(command, args, options),
    };
  };
  const attempt = (run) =>
    publishReview(
      policy,
      { pr: '7', base: BASE, head: HEAD, report: report('APPROVE') },
      run,
    );
  const missing = wrap((args) => {
    if (args[1].endsWith('/reviews'))
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  });
  assert.throws(
    () => attempt(missing.run),
    /^ReviewNotPosted: Review not posted: .*gh is not installed/,
  );
  const silent = wrap((args) =>
    args[1].endsWith('/reviews') ? '{}' : undefined,
  );
  assert.throws(
    () => attempt(silent.run),
    /^ReviewNotPosted: Review not posted: GitHub returned no review URL/,
  );
  const notFound = wrap((args) => {
    if (args[1].endsWith('/pulls/7'))
      throw ghFailure(404, { message: 'Not Found' });
  });
  assert.throws(
    () => attempt(notFound.run),
    /^ReviewNotPosted: Review not posted: gh api \S+\/pulls\/7 failed: HTTP 404: Not Found/,
  );
  assert.equal(notFound.github.posts.length, 0);
});

test('moved or mismatched SHAs post nothing and ask for a fresh review', () => {
  for (const github of [
    mockGitHub({ head: 'c'.repeat(40) }),
    mockGitHub({ base: 'c'.repeat(40) }),
  ]) {
    assert.throws(
      () => publish('REQUEST CHANGES', github),
      /^ReviewNotPosted: Review not posted: pull request #7 is now at .*Run a fresh review for the new commits/,
    );
    assert.equal(github.posts.length, 0);
  }
  const mismatch = mockGitHub();
  assert.throws(
    () =>
      publish('APPROVE', mismatch, {
        report: report('APPROVE', `${BASE}..${'c'.repeat(40)}`),
      }),
    /^ReviewNotPosted: Review not posted: the report reviewed .*Run a fresh review/,
  );
  assert.deepEqual(mismatch.calls, []);
  // A report that names no commits is not posted on the strength of the
  // arguments alone.
  const unbound = mockGitHub();
  assert.throws(
    () =>
      publish('APPROVE', unbound, {
        report: 'Verdict: APPROVE\nFindings: none',
      }),
    /^ReviewNotPosted: Review not posted: the report has no Base\/Head: <sha>\.\.<sha> line/,
  );
  assert.deepEqual(unbound.calls, []);
  // Abbreviated SHAs in the report still bind to the dispatched pair.
  const short = mockGitHub();
  publish('BLOCKED', short, {
    report: report('BLOCKED', `${BASE.slice(0, 7)}..${HEAD.slice(0, 7)}`),
  });
  assert.equal(short.posts.length, 1);
  for (const options of [
    { pr: 'abc' },
    { base: 'a'.repeat(7) },
    { head: undefined },
    { report: '  ' },
  ]) {
    const github = mockGitHub();
    assert.throws(
      () => publish('APPROVE', github, options),
      /^ReviewNotPosted: Review not posted:/,
    );
    assert.deepEqual(github.calls, []);
  }
});

test('the publish-review command reports every failure as not posted', () => {
  // A copy of the script outside the repository has no policy file to load.
  // realpathSync keeps the copy's module URL equal to its argv path, which
  // the script compares before it runs as a command.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-policy-')));
  mkdirSync(join(base, 'scripts'));
  const script = join(base, 'scripts/agent-policy.mjs');
  writeFileSync(
    script,
    readFileSync(new URL('./agent-policy.mjs', import.meta.url)),
  );
  writeFileSync(
    join(base, 'scripts/cli.cjs'),
    readFileSync(new URL('./cli.cjs', import.meta.url)),
  );
  const reportPath = join(base, 'review.md');
  writeFileSync(reportPath, report('APPROVE'));
  const publishCommand = (...args) =>
    spawnSync(process.execPath, [script, 'publish-review', ...args], {
      encoding: 'utf8',
    });
  const noPolicy = publishCommand(
    '--pr',
    '7',
    '--base',
    BASE,
    '--head',
    HEAD,
    '--report',
    reportPath,
  );
  assert.equal(noPolicy.status, 1);
  assert.match(
    noPolicy.stderr,
    /^Review not posted: cannot load \.agents\/policy\.json: /,
  );
  assert.equal(noPolicy.stdout, '');
  const noReport = publishCommand('--pr', '7');
  assert.equal(noReport.status, 1);
  assert.match(
    noReport.stderr,
    /^Review not posted: --report <file> is required/,
  );
});

test('review publication runs only from a manual PR review', () => {
  const files = render();
  for (const path of [
    `.claude/skills/${PREFIX}review-code/SKILL.md`,
    `.agents/skills/${PREFIX}review-code/SKILL.md`,
  ]) {
    const content = files.get(path);
    assert.ok(
      lineWith(content, 'review_mode=requested'),
      `${path} must dispatch requested-mode reviews`,
    );
    assert.ok(
      lineWith(content, /^For a pull request target/, 'For a branch target'),
      `${path} must publish for pull requests and skip branches`,
    );
    assert.ok(
      lineWith(
        content,
        'agent-policy.mjs publish-review',
        '--base',
        '--head',
        'the only way this skill posts',
      ),
      `${path} must post only through publish-review with the reviewed SHAs`,
    );
    assert.ok(
      lineWith(content, 'Posted: none (branch review)'),
      `${path} must keep branch reviews report-only`,
    );
    assert.ok(
      lineWith(content, 'fresh review'),
      `${path} must ask for a fresh review when the SHAs moved`,
    );
    assert.doesNotMatch(content, /nothing in this flow writes to GitHub/, path);
  }
  for (const path of [
    `.claude/agents/${PREFIX}code-reviewer.md`,
    `.codex/agents/${PREFIX}code-reviewer.toml`,
  ]) {
    const content = files.get(path);
    assert.ok(
      lineWith(content, /^Never:/, 'touch issues, projects, or PRs'),
      `${path} must keep the reviewer read-only`,
    );
    assert.ok(
      lineWith(content, '`requested` mode', 'never post to it'),
      `${path} must leave publication to the skill`,
    );
  }
  // The delivery owner's pre-PR review relays its verdict and posts nothing.
  for (const path of DELIVERY)
    assert.ok(lineWith(files.get(path), 'review_mode=pre_pr'), path);
  for (const [path, content] of files)
    if (!path.includes(`/${PREFIX}review-code/`))
      assert.doesNotMatch(content, /publish-review/, path);
});

test('generated definitions in the repository are current', () => {
  assert.deepEqual(check(), []);
});

test('generate writes every file and check reports stale or orphaned output', () => {
  const base = mkdtempSync(join(tmpdir(), 'agent-policy-'));
  mkdirSync(join(base, '.agents/roles'), { recursive: true });
  mkdirSync(join(base, '.agents/workflows'), { recursive: true });
  writeFileSync(
    join(base, '.agents/policy.json'),
    JSON.stringify({
      ...policy,
      roles: { sample: 'code-review' },
    }),
  );
  writeFileSync(join(base, '.agents/roles/sample.md'), source);
  writeFileSync(
    join(base, '.agents/workflows/flow.md'),
    '---\nname: flow\ndescription: Flow.\n---\nBody.\n',
  );
  const written = generate(base);
  assert.deepEqual(written, [
    `.agents/skills/${PREFIX}flow/SKILL.md`,
    `.agents/skills/${PREFIX}flow/agents/openai.yaml`,
    `.claude/agents/${PREFIX}sample.md`,
    `.claude/skills/${PREFIX}flow/SKILL.md`,
    `.codex/agents/${PREFIX}sample.toml`,
  ]);
  assert.deepEqual(check(base), []);
  writeFileSync(join(base, `.codex/agents/${PREFIX}sample.toml`), 'edited');
  writeFileSync(join(base, `.claude/agents/${PREFIX}orphan.md`), 'orphan');
  writeFileSync(join(base, '.claude/agents/personal.md'), 'not ours');
  assert.deepEqual(check(base), [
    `.claude/agents/${PREFIX}orphan.md`,
    `.codex/agents/${PREFIX}sample.toml`,
  ]);
  generate(base);
  assert.deepEqual(check(base), []);
  assert.equal(
    readFileSync(join(base, '.claude/agents/personal.md'), 'utf8'),
    'not ours',
  );
  // Rebinding the same sources renames the output and resolves the text.
  writeFileSync(
    join(base, '.agents/policy.json'),
    JSON.stringify({ ...other, roles: { sample: 'code-review' } }),
  );
  writeFileSync(
    join(base, '.agents/roles/sample.md'),
    source.replace('Shared line.', 'Shared {{label}} line in {{repository}}.'),
  );
  assert.deepEqual(generate(base), [
    '.agents/skills/other-flow/SKILL.md',
    '.agents/skills/other-flow/agents/openai.yaml',
    '.claude/agents/other-sample.md',
    '.claude/skills/other-flow/SKILL.md',
    '.codex/agents/other-sample.toml',
  ]);
  assert.match(
    readFileSync(join(base, '.claude/agents/other-sample.md'), 'utf8'),
    /Shared Other line in example\/other\./,
  );
  assert.match(
    readFileSync(
      join(base, '.agents/skills/other-flow/agents/openai.yaml'),
      'utf8',
    ),
    /display_name: 'Other: flow'/,
  );
});

test('a role without a policy entry or source is rejected', () => {
  const base = mkdtempSync(join(tmpdir(), 'agent-policy-'));
  mkdirSync(join(base, '.agents/roles'), { recursive: true });
  writeFileSync(
    join(base, '.agents/policy.json'),
    JSON.stringify({ ...policy, roles: { missing: 'code-review' } }),
  );
  assert.throws(() => render(base), /Role missing has no source/);
  writeFileSync(
    join(base, '.agents/roles/extra.md'),
    source.replace('name: sample', 'name: extra'),
  );
  assert.throws(() => render(base), /Role extra has no entry/);
});

test('review entry points share bounded packets and preserve independent coverage', () => {
  const files = render();
  const review = readFileSync(
    new URL('../.agents/review.md', import.meta.url),
    'utf8',
  );
  for (const path of [
    ...DELIVERY,
    `.claude/skills/${PREFIX}review-code/SKILL.md`,
    `.agents/skills/${PREFIX}review-code/SKILL.md`,
    `.claude/agents/${PREFIX}code-reviewer.md`,
    `.codex/agents/${PREFIX}code-reviewer.toml`,
  ]) {
    const content = files.get(path);
    assert.ok(content.includes('.agents/review.md'), path);
    for (const field of [
      'accepted decisions',
      'changed-file summary',
      'validation results',
      'verified prerequisites',
    ])
      assert.ok(content.includes(field), `${path}: ${field}`);
  }
  for (const rule of [
    'full in-scope base/head diff',
    'relevant callers and contracts',
    'Retrieve only missing or stale context',
    'previous base/head SHAs',
    'complete previous report',
    'Expand review when subsequent changes affect additional behavior',
    'including changes introduced by a moved base',
    'missed earlier',
    'exact reviewed base/head pair',
    'otherwise perform a complete initial review',
  ])
    assert.ok(review.includes(rule), rule);
  assert.doesNotMatch(review, /report only defects the fixes introduced/);
});

test('evidence reuse retains complete relevant output and meaningful validation', () => {
  const evidence = readFileSync(
    new URL('../.agents/evidence.md', import.meta.url),
    'utf8',
  );
  for (const rule of [
    'targeted `rg` searches',
    'Read each unchanged file once',
    'A new commit SHA alone does not invalidate',
    'local temporary file outside tracked paths',
    'Keep the file available',
    'Never let a filter hide a failing exit status',
    'retrieve the missing part',
    'Never act on partial output',
    'never wait for, poll, or rerun remote CI',
  ])
    assert.ok(evidence.includes(rule), rule);
  const files = render();
  for (const path of DELIVERY) {
    const build = section(files.get(path), 'Build');
    assert.match(build, /focused tests/);
    assert.match(build, /every required scope-appropriate check/);
    assert.match(build, /rerun affected checks and broaden validation/);
    assert.match(
      build,
      /Meaningful behavioral tests and required checks remain mandatory/,
    );
    const claim = section(files.get(path), 'Claim');
    assert.match(claim, /Reuse current metadata and verified prerequisites/);
    assert.match(claim, /one useful claim comment/);
    assert.match(claim, /Do not add status-only comments or repeat the claim/);
  }
});

test('optional implementation delegation requires a benefit beyond task size', () => {
  const files = render();
  for (const path of IMPLEMENT) {
    const exception = section(
      files.get(path),
      'Isolated implementer exception',
    );
    assert.match(exception, /request says `isolated`/);
    assert.match(exception, /name a concrete benefit/);
    assert.match(exception, /Task size alone does not justify delegation/);
    assert.match(exception, /bounded assignment/);
  }
  for (const path of QUEUE) {
    assert.match(
      section(files.get(path), 'Deliver'),
      /concrete-benefit delegation rule/,
    );
    const parallel = section(files.get(path), 'Parallel exception');
    assert.match(parallel, /explicitly asked for parallel delivery/);
    assert.match(parallel, /different groups/);
  }
});
