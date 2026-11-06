import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const staticDir = process.env.STATIC_DIR ?? fileURLToPath(new URL('../client/dist', import.meta.url));
const dataFile = process.env.DATA_FILE || undefined;

// The deploy passes the commit SHA as a build arg (Dockerfile -> APP_VERSION); /healthz reports its short form.
const version = (process.env.APP_VERSION || 'dev').slice(0, 7);

const app = createApp({ staticDir, dataFile, version });

app.server.listen(port, host, () => {
  console.log(`[poker] listening on http://${host}:${port} (version ${version}, static: ${staticDir}, data: ${dataFile ?? 'memory only'})`);
});

// Last resort: never die silently. Save what we can and exit non-zero so Docker restarts us.
for (const ev of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(ev, (err) => {
    console.error(`[poker] ${ev}:`, err);
    try {
      app.save();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}

let closing = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    console.log(`[poker] ${sig} received, saving rooms and shutting down`);
    let code = 0;
    try {
      await app.close();
    } catch (err) {
      // close() already logged why; exit non-zero so the failed save is visible to Docker and the deploy.
      console.error('[poker] shutdown failed:', err);
      code = 1;
    }
    process.exit(code);
  });
}
