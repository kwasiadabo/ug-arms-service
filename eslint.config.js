/**
 * ESLint configuration for the UG-ARMS backend (Node.js, ES modules).
 *
 * @author Kwasi Adabo Boakye
 */
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import globals from 'globals';

export default defineConfig([
  { ignores: ['node_modules/**', 'logs/**', 'uploads/**', 'storage-local/**', 'storage-test/**', 'test-results/**'] },
  {
    files: ['**/*.{js,mjs}'],
    plugins: { js },
    extends: ['js/recommended'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-duplicate-imports': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
]);
