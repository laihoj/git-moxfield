import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import tseslint from 'typescript-eslint';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Untrusted content must be rendered through React, never as raw HTML.',
        },
      ],
    },
  },
  {
    // In-app links and GET forms go through src/components/ui/navigation.tsx, which decides
    // how Next.js prefetches them. (Listed before the src/core and src/integrations rules,
    // which replace it there and forbid every `next/*` import anyway.)
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/components/ui/navigation.tsx', 'src/components/ui/navigation.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'next/link',
              message: 'Use Link from @/components/ui/navigation: it applies the app’s prefetch policy.',
            },
            {
              name: 'next/form',
              message: 'Use Form from @/components/ui/navigation: it applies the app’s prefetch policy.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/integrations/*',
                '@/server/*',
                '@/app/*',
                '@/components/*',
                'next',
                'next/*',
                'react',
              ],
              message: 'src/core must stay framework- and platform-independent.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/integrations/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/server/*', '@/app/*', '@/components/*', 'next', 'next/*', 'react'],
              message: 'Integrations may depend on src/core only.',
            },
          ],
        },
      ],
    },
  },
  globalIgnores([
    // Next.js build directories: `.next` and every `NEXT_DIST_DIR` variant (`.next-e2e`, ...).
    '.next*/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'playwright-report/**',
    'test-results/**',
    'drizzle/**',
    'data/**',
    'coverage/**',
    // Output of local `netlify build` / `netlify dev` runs: bundled functions, not source.
    '.netlify/**',
  ]),
]);
