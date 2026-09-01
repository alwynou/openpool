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
        if (result.failed > 0) {
          console.warn('Scheduled upload cleanup completed with failures', {
            failed: result.failed,
            pendingCandidates: result.pendingCandidates,
            cleanupCandidates: result.cleanupCandidates,
          });
        }
      }),
    );
  },
} satisfies ExportedHandler<Env>;
