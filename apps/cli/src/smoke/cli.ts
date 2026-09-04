import { CliFailure, safeError } from '../errors.js';
import { SMOKE_HELP, smokeOptions } from './options.js';
import { runSmoke } from './run.js';

const abort = new AbortController();
const interrupt = () => abort.abort(new CliFailure('SMOKE_INTERRUPTED', 'Smoke was interrupted.', 130));
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
// A closed log consumer must abort the owned child and still allow bounded cleanup.
process.stdout.on('error', interrupt); process.stderr.on('error', interrupt);
try {
  const options = smokeOptions(process.argv.slice(2), process.env);
  if (!options) process.stdout.write(SMOKE_HELP);
  else {
    const { report, reportPath } = await runSmoke(options, { signal: abort.signal,
      progress: (value) => { process.stdout.write(`${JSON.stringify(value)}\n`); } });
    process.stdout.write(`${JSON.stringify({ event: 'smoke-result', status: report.status, reportPath,
      objects: report.objects.length, pendingCleanup: report.pendingCleanup.length, failures: report.failures })}\n`);
    process.exitCode = abort.signal.aborted ? 130 : report.status === 'PASSED' ? 0 : 1;
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: safeError(error) })}\n`);
  process.exitCode = error instanceof CliFailure ? error.exitCode : 1;
} finally {
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
