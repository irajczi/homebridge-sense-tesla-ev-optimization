import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Enforce consistent indentation
      'indent': ['warn', 2, { SwitchCase: 1 }],
      // Enforce single quotes
      'quotes': ['warn', 'single'],
      // Require semicolons
      'semi': ['warn', 'always'],
      // Warn on unused variables (but allow underscore-prefixed ones)
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Allow explicit any in some cases
      '@typescript-eslint/no-explicit-any': 'warn',
      // Enforce consistent line endings
      'eol-last': ['warn', 'always'],
      // No trailing whitespace
      'no-trailing-spaces': 'warn',
      // Comma dangle for cleaner diffs
      'comma-dangle': ['warn', 'always-multiline'],
    },
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
  },
  {
    // Ignore compiled output
    ignores: ['dist/**', 'node_modules/**'],
  },
);
