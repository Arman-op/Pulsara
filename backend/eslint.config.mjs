import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint rules for the API.
 *
 * Type-aware linting is enabled deliberately: the rules that catch real defects
 * in this codebase (a floating promise from a fire-and-forget database write, an
 * unawaited async handler) require type information and are invisible to the
 * syntactic ruleset.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // An unhandled rejection in a request handler takes the process down via
      // the `unhandledRejection` hook, so an un-awaited promise is a real bug.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Underscore-prefixed parameters are the agreed marker for "required by a
      // signature, deliberately unused".
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // `any` erases the guarantees the rest of this configuration buys.
      '@typescript-eslint/no-explicit-any': 'error',

      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'no-param-reassign': 'error',
    },
  },
  {
    // The seed script is a CLI entry point; printing progress is its interface.
    files: ['prisma/seed.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    /**
     * Tests read `response.body`, which supertest types as `any` because the
     * shape is whatever the server sent. Asserting on it is the entire point of
     * the file, and an unexpected shape fails the assertion loudly — which is
     * the protection these rules exist to provide in `src`, where a wrong shape
     * would instead be silently carried into production code.
     */
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    // This file configures the linter and is not part of the TypeScript
    // project, so the type-aware rules have no program to consult.
    files: ['eslint.config.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
