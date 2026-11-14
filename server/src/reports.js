// Where abuse reports go. Every report is logged, and if REPORT_WEBHOOK_URL is
// set it is posted there too (Slack and Discord incoming webhooks both work),
// so whoever runs the server hears about it within seconds.

export function createReportSink(env = process.env, log = console) {
  const url = env.REPORT_WEBHOOK_URL;
  return async function onReport(report, { suspended } = {}) {
    const who = report.target.description ? `${report.target.nickname} · ${report.target.description}` : report.target.nickname;
    const lines = [
      `Whisper report (${report.reason}) against ${who} [${report.target.id}]`,
      report.text ? `Message: "${report.text}"` : 'No message text (not accepted yet, or reported from the nearby list)',
      report.note ? `Reporter's note: ${report.note}` : null,
      suspended ? 'Auto-suspended: 3 people have reported this person.' : null,
      `Report ${report.id} at ${report.at}`,
    ].filter(Boolean);
    const summary = lines.join('\n');
    log.log?.(`[report] ${JSON.stringify({ id: report.id, reason: report.reason, target: report.target.id, suspended: Boolean(suspended) })}`);
    if (!url) return;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: summary, content: summary.slice(0, 1900) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) log.warn?.(`[report] webhook answered ${res.status}`);
  };
}
