import { build } from 'esbuild';

// Bundle the workspace-private SDK's TypeScript exports for plain Node.js.
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
});
