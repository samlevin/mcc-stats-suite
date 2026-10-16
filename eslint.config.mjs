import eslint from '@eslint/js';
import markdown from '@eslint/markdown';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const javascriptFiles = ['**/*.{js,mjs,cjs}'];
const typescriptFiles = ['**/*.{ts,tsx,mts,cts}'];
const markdownFiles = ['**/*.md'];

export default tseslint.config(
  {
    ignores: [
      '**/cdk.out/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/.terraform/**',
      '**/.turbo/**',
      '**/.tap/**',
      // Agent-owned linked worktrees are full repository copies. ESLint does
      // not read .gitignore, so without these entries `eslint .` in the main
      // checkout type-checks every worktree and can exhaust the V8 heap.
      '.claude/worktrees/**',
      '.codex/worktrees/**',
      // release-please writes changelogs from commit subjects, so bracketed
      // text such as `[UNKNOWN]` would fail the Markdown rules.
      '**/CHANGELOG.md',
      // Untracked personal agent instructions, such as CLAUDE.local.md.
      '**/*.local.md',
      '**/AGENTS.override.md',
    ],
  },
  {
    ...eslint.configs.recommended,
    files: javascriptFiles,
    languageOptions: {
      globals: globals.node,
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: typescriptFiles,
  })),
  {
    files: typescriptFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  {
    files: ['**/test/**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  // eslint-config-prettier only turns off JavaScript and TypeScript rules that
  // conflict with Prettier, so it applies to code files and never to Markdown.
  {
    ...prettier,
    files: [...javascriptFiles, ...typescriptFiles],
  },
  // Markdown is checked for broken structure (link fragments, table column
  // counts, reference links, images, headings), not reformatted. Prettier
  // keeps ignoring Markdown, and code blocks inside it are not linted as code.
  // GFM parses GitHub tables; YAML front matter covers skill and agent files.
  ...markdown.configs.recommended.map((config) => ({
    ...config,
    files: markdownFiles,
    language: 'markdown/gfm',
    languageOptions: {
      frontmatter: 'yaml',
    },
  })),
  // Rules changed for specific files, each with its reason.
  {
    // The prose skill marks its example passages with literal tell numbers
    // such as `[7]` and writes placeholders such as
    // `[fast-paced/digital/modern]`. Both are text, not reference links.
    files: [
      '.agents/workflows/write-prose.md',
      '.agents/skills/mcc-write-prose/SKILL.md',
      '.claude/skills/mcc-write-prose/SKILL.md',
    ],
    rules: {
      'markdown/no-missing-label-refs': [
        'error',
        {
          allowLabels: [
            ...Array.from({ length: 20 }, (_, index) => String(index + 1)),
            'bracketed',
            'comprehensive/holistic/nuanced',
            'fast-paced/digital/modern',
          ],
        },
      ],
    },
  },
  {
    // The template has its own title, then the specification an author
    // copies, whose title is a second H1 placeholder (`# <Component name>`).
    files: ['specs/TEMPLATE.md'],
    rules: {
      'markdown/no-multiple-h1': 'off',
    },
  },
);
