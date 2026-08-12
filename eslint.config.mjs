import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const typescriptFiles = ['**/*.{ts,tsx,mts,cts}'];

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
    ],
  },
  {
    ...eslint.configs.recommended,
    files: ['**/*.{js,mjs,cjs}'],
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
  prettier,
);
