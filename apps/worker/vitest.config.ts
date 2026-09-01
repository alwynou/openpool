import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations('../../database/migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ADMIN_BOOTSTRAP_TOKEN: 'test-bootstrap-token',
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
