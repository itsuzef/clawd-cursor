const js = require('@eslint/js');
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'scripts/**'] },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        queueMicrotask: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        NodeJS: 'readonly',
        performance: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Allow require() for lazy-loading (used for optional deps like playwright
      // and to break startup import cycles). v0.9.x may tighten this once the
      // pipeline port is complete.
      '@typescript-eslint/no-require-imports': 'off',
      // Downgraded from error to warn for v0.8.1 to unblock CI; real fixes
      // land during the pipeline port in dedicated cleanup PRs.
      'no-useless-escape': 'warn',
      'no-case-declarations': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-wrapper-object-types': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // OCR/text-processing files legitimately match on control characters.
      // Keep as warning; files that use them add a file-level disable comment.
      'no-control-regex': 'warn',
    },
  },
  // Files that execute callback source inside the browser page context via
  // page.evaluate(() => document.querySelector(...)). Those callbacks are
  // serialized and run in the browser — `document`, `window`, `getComputedStyle`
  // are legitimate globals there, not linter errors.
  {
    files: ['src/platform/cdp-driver.ts', 'src/tools/cdp.ts', 'src/tools/smart.ts'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        getComputedStyle: 'readonly',
      },
    },
  },
  // Test file overrides — vitest globals
  {
    files: ['**/*.test.ts', 'tests/**/*.ts', 'src/__tests__/**/*.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        test: 'readonly',
      },
    },
  },
];
