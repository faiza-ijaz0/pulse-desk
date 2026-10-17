import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'packages/db/src/generated/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // docs/conventions.md: prefer type aliases; interfaces only for declaration merging.
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },

  // Plain JS config files are not part of any tsconfig project.
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: globals.node },
  },

  // Node workspaces.
  {
    files: ['apps/api/**/*.ts', 'packages/db/**/*.ts', 'e2e/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  // Web app: React hooks + accessibility rules, browser globals.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    ...jsxA11y.flatConfigs.strict,
    languageOptions: {
      ...jsxA11y.flatConfigs.strict.languageOptions,
      globals: globals.browser,
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  // Architectural boundaries (see docs/conventions.md).
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@pulsedesk/db', '@pulsedesk/db/*'],
              message: 'The web app must not access the database package.',
            },
            {
              group: ['@pulsedesk/api', '**/apps/api/**'],
              message: 'Apps must not import other apps.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@pulsedesk/web', '**/apps/web/**'],
              message: 'Apps must not import other apps.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: '@pulsedesk/shared must run in both Node and the browser.',
            },
            {
              group: ['@pulsedesk/db', '@prisma/*'],
              message: '@pulsedesk/shared must not depend on Prisma.',
            },
          ],
        },
      ],
    },
  },

  // Tests may use non-null assertions on known fixtures.
  {
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
