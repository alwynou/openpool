import {
  createWorker,
  runScheduledMaintenance,
} from './composition/root';
import type { Env } from './env';

const app = createWorker();

export default {
  fetch: (request, env, context) => app.fetch(request, env, context),
  scheduled: (_controller, env, context) => {
    context.waitUntil(
      runScheduledMaintenance(env).then((result) => {
        if (result.failed > 0 || result.migrationCleanupFailed > 0) {
          console.warn('Scheduled storage cleanup completed with failures', {
            uploadCleanupFailed: result.failed,
            pendingCandidates: result.pendingCandidates,
            cleanupCandidates: result.cleanupCandidates,
            migrationCleanupFailed: result.migrationCleanupFailed,
            migrationCleanupCandidates: result.migrationCleanupCandidates,
          });
        }
      }),
    );
  },
} satisfies ExportedHandler<Env>;
