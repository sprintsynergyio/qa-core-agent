// ESLint flat config for the agent, its CLIs, the gateway and the scripts.
// The dashboard (dashboard/) is a separate package and is typechecked by its
// own build; generated frameworks and run data are never linted.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/', 'dashboard/', 'output/', 'data/', 'eval-results/', 'examples/', 'dist/', 'build/', 'playwright-report/', 'test-results/', '.qa-core/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Model responses, Playwright evaluate payloads and JSON read from run
      // folders are untyped at the boundary; the code narrows them by hand.
      '@typescript-eslint/no-explicit-any': 'off',
      // ANSI colour codes are stripped from Playwright output on purpose.
      'no-control-regex': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // Functions passed to page.evaluate run in the browser.
    files: ['src/agent/**/*.ts', 'src/server/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
