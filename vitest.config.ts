import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { sharedResolve } from './vitest.shared.ts';

export default defineConfig({
  plugins: [react()],
  resolve: sharedResolve,
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.{ts,tsx}',
      'tests/unit/**/*.test.{ts,tsx}',
      'tests/integration/**/*.test.{ts,tsx}',
    ],
    setupFiles: ['tests/support/setup.ts'],
    restoreMocks: true,
  },
});
