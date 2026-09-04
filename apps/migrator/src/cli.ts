#!/usr/bin/env node
import { runCli } from './migrate.js';

try {
  await runCli(process.argv.slice(2));
  console.log('Migration completed.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Migration failed.');
  process.exitCode = 1;
}
