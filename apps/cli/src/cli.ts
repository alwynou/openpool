#!/usr/bin/env node
import { CliFailure } from './errors.js';
import { runCli } from './run.js';

const interrupted = new AbortController();
let outputFailed = false;
const onOutputError = () => {
  outputFailed = true;
  process.exitCode = 1;
  interrupted.abort(new CliFailure('OUTPUT_UNAVAILABLE', 'Unable to write CLI output.', 1));
};
// A consumer may close a pipe (e.g. head). Do not emit an unhandled EPIPE stack
// or continue an in-flight operation after its output channel fails.
process.stdout.on('error', onOutputError);
process.stderr.on('error', onOutputError);
const onInterrupt = () => interrupted.abort(new CliFailure('INTERRUPTED', 'The command was interrupted. Inspect upload state before retrying.', 130));
const onTerminate = () => interrupted.abort(new CliFailure('INTERRUPTED', 'The command was terminated. Inspect upload state before retrying.', 143));
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);
try {
  const code = await runCli(process.argv.slice(2), { signal: interrupted.signal });
  process.exitCode = outputFailed ? 1 : code;
} finally {
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
