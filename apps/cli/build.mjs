import { build } from 'esbuild';

// Bundle the workspace-private SDK's TypeScript exports for plain Node.js.
await build({
  entryPoints: { cli: 'src/cli.ts', 'smoke-cli': 'src/smoke/cli.ts', 'smoke-observer': 'src/smoke/observer.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
});
