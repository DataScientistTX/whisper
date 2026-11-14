import http from 'node:http';
import { createApp } from './app.js';
import { createApns } from './apns.js';
import { filterFromEnv } from './filter.js';
import { createReportSink } from './reports.js';

const port = Number(process.env.PORT) || 3000;
const push = createApns(process.env);
const { handler, state } = createApp({
  push,
  filter: filterFromEnv(process.env),
  adminToken: process.env.ADMIN_TOKEN || null,
  onReport: createReportSink(process.env),
});
if (!process.env.REPORT_WEBHOOK_URL) console.warn('[whisper] REPORT_WEBHOOK_URL not set: abuse reports only go to the log');

const server = http.createServer(handler);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 15_000; // slow-client protection
server.requestTimeout = 20_000;
server.listen(port, () => {
  console.log(`[whisper] listening on :${port} (push ${push.configured ? 'enabled' : 'disabled'})`);
});

const sweeper = setInterval(() => state.sweep(), 30_000);
sweeper.unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(sweeper);
    push.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
