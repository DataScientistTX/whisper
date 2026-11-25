#!/usr/bin/env node
// Puts a fake person ("Test Bot · Grey Tesla") next to you so you can test with one phone.
// It stays visible, sends you one message, and auto-accepts and replies to anything you send it.
//
//   node scripts/fake-person.mjs <server-url> <lat> <lon>
//   node scripts/fake-person.mjs https://whisper-production.up.railway.app 30.2672 -97.7431

const [base, latArg, lonArg] = process.argv.slice(2);
if (!base || !latArg || !lonArg) {
  console.error('usage: node scripts/fake-person.mjs <server-url> <lat> <lon>');
  process.exit(1);
}
const url = base.replace(/\/+$/, '');
// Stand about 15 m north-east of the given point.
const lat = Number(latArg) + 0.0001;
const lon = Number(lonArg) + 0.0001;
const opener = process.env.FAKE_MESSAGE ?? 'Hi from Test Bot! Your test setup works 👋';
const replyText = process.env.FAKE_REPLY ?? 'Got it, thanks! 👍';
const tickMs = Number(process.env.FAKE_TICK_MS) || 4000;

let token = null;
let greeted = new Set();

async function call(method, path, body) {
  const res = await fetch(url + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-whisper-foreground': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401 && token) { token = null; throw new Error('session expired, rejoining'); }
  return { status: res.status, data };
}

async function join() {
  const r = await call('POST', '/v1/sessions', { nickname: 'Test Bot', description: 'Grey Tesla' });
  if (r.status !== 201) throw new Error(`could not create session: ${r.status} ${JSON.stringify(r.data)}`);
  token = r.data.token;
  greeted = new Set();
  console.log(`[bot] visible as "${r.data.nickname} · ${r.data.description}" at ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
}

async function tick() {
  if (!token) await join();
  await call('PUT', '/v1/me/location', { lat, lon, accuracy: 5 });
  const near = await call('GET', '/v1/nearby?radius=wide');
  for (const p of near.data?.people ?? []) {
    if (greeted.has(p.id)) continue;
    greeted.add(p.id);
    const r = await call('POST', '/v1/requests', { to: p.id, text: opener });
    console.log(`[bot] asked to message ${p.nickname}${p.description ? ' · ' + p.description : ''} (~${p.distance} m, ${p.direction}): ${r.status}`);
  }
  const inbox = await call('GET', '/v1/inbox');
  for (const r of inbox.data?.incoming ?? []) {
    if (r.status !== 'pending') continue;
    const acc = await call('POST', `/v1/requests/${r.id}/accept`);
    console.log(`[bot] accepted from ${r.from.nickname}: "${acc.data?.text}"`);
    if (acc.status === 200 && !r.isReply) {
      const rep = await call('POST', '/v1/requests', { replyTo: r.id, text: replyText });
      console.log(`[bot] replied to ${r.from.nickname}: ${rep.status}`);
    }
  }
  for (const r of inbox.data?.sent ?? []) {
    if (r.status !== 'pending' && !greeted.has('status:' + r.id)) {
      greeted.add('status:' + r.id);
      console.log(`[bot] ${r.to.nickname} ${r.status} the bot's message`);
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (token) await call('DELETE', '/v1/me').catch(() => {});
    console.log('\n[bot] hidden, bye');
    process.exit(0);
  });
}

console.log('[bot] Ctrl-C to stop');
for (;;) {
  try { await tick(); } catch (e) { console.warn('[bot]', e.message); }
  await new Promise((r) => setTimeout(r, tickMs));
}
