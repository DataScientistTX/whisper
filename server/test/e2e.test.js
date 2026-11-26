// End-to-end: starts the real server process (src/index.js) the way Railway
// does, and plays out whole conversations between "phones" over HTTP, plus the
// fake-person script. Real clock, no fakes, so these take a few seconds.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const fakePerson = fileURLToPath(new URL('../../scripts/fake-person.mjs', import.meta.url));
const ADMIN = 'e2e-admin-' + randomBytes(8).toString('hex');
const DEMO = 'e2e-demo-code';
const M = 1 / 111_195;

let proc, base, output = '';
const children = [];

const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer().listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  }).on('error', reject);
});

async function waitFor(fn, { timeout = 8000, every = 50, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n--- server output ---\n${output}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: { PATH: process.env.PATH, PORT: String(port), ADMIN_TOKEN: ADMIN, REVIEW_DEMO_CODE: DEMO },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });
  await waitFor(async () => (await fetch(base + '/health')).ok, { what: 'server to start' });
});

after(async () => {
  for (const c of children) c.kill('SIGKILL');
  if (proc.exitCode === null) proc.kill('SIGKILL');
});

// A phone: its own IP, token and push token, like the iOS app.
function phone(name) {
  const ip = `10.9.${randomBytes(2).join('.')}`;
  const p = {
    name, token: null, id: null,
    async call(method, path, body) {
      const res = await fetch(base + path, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': ip,
          'x-whisper-foreground': '1',
          ...(p.token ? { authorization: `Bearer ${p.token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    },
    async goVisible({ description = '', lat, lon, heading } = {}) {
      const r = await p.call('POST', '/v1/sessions', { description, pushToken: randomBytes(32).toString('hex') });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      p.token = r.body.token;
      p.id = r.body.id;
      p.nickname = r.body.nickname;
      if (lat !== undefined) await p.moveTo(lat, lon, heading);
      return r.body;
    },
    async moveTo(lat, lon, heading) {
      const r = await p.call('PUT', '/v1/me/location', { lat, lon, accuracy: 5, heading });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    },
    nearby: async () => (await p.call('GET', '/v1/nearby?radius=wide')).body.people,
    inbox: async () => (await p.call('GET', '/v1/inbox')).body,
    goHidden: () => p.call('DELETE', '/v1/me'),
  };
  return p;
}

test('the server reports its version and health', async () => {
  const root = await (await fetch(base + '/')).json();
  assert.equal(root.name, 'whisper');
  assert.match(root.version, /^\d+\.\d+\.\d+$/);
  assert.match(output, /listening on :\d+ \(push disabled\)/);
});

test('two drivers: see each other, message, accept, reply, go hidden', async () => {
  const LAT = 30.2672, LON = -97.7431;
  const toyota = phone('toyota');
  const jeep = phone('jeep');
  await toyota.goVisible({ description: 'White Toyota', lat: LAT, lon: LON, heading: 0 });
  await jeep.goVisible({ description: 'Black Jeep', lat: LAT + 30 * M, lon: LON, heading: 0 });

  // The Toyota sees the Jeep about 30 m ahead, with no coordinates.
  const seen = (await toyota.nearby()).find((p) => p.id === jeep.id);
  assert.equal(seen.description, 'Black Jeep');
  assert.equal(seen.direction, 'ahead');
  assert.ok(seen.distance >= 25 && seen.distance <= 35);
  assert.equal('lat' in seen, false);

  const sent = await toyota.call('POST', '/v1/requests', { to: jeep.id, text: 'Your trunk is open' });
  assert.equal(sent.status, 201);
  const requestId = sent.body.requests[0].id;

  // The Jeep sees who wants to talk, but not what they said, until accepting.
  let box = await jeep.inbox();
  assert.equal(box.incoming[0].status, 'pending');
  assert.equal(box.incoming[0].text, null);
  assert.equal(box.incoming[0].from.description, 'White Toyota');
  const acc = await jeep.call('POST', `/v1/requests/${requestId}/accept`);
  assert.equal(acc.body.text, 'Your trunk is open');
  assert.equal((await toyota.inbox()).sent[0].status, 'accepted');

  // The Toyota drives off; the Jeep still gets to say thanks.
  await new Promise((r) => setTimeout(r, 2100)); // slow enough to pass the ~430 km/h spoofing check
  await toyota.moveTo(LAT + 220 * M, LON, 0);
  assert.equal((await jeep.nearby()).some((p) => p.id === toyota.id), false);
  box = await jeep.inbox();
  assert.equal(box.incoming[0].canReply, true);
  const reply = await jeep.call('POST', '/v1/requests', { replyTo: requestId, text: 'Thanks, closed it!' });
  assert.equal(reply.status, 201);
  const toyotaBox = await toyota.inbox();
  const got = toyotaBox.incoming.find((r) => r.isReply);
  assert.equal(got.text, 'Thanks, closed it!');
  assert.equal(got.from.description, 'Black Jeep');

  // Going hidden erases the session for good.
  assert.equal((await toyota.goHidden()).status, 200);
  assert.equal((await toyota.call('GET', '/v1/me')).status, 401);
  assert.equal((await jeep.inbox()).incoming[0].canReply, false);
  await jeep.goHidden();
});

test('a bar: message everyone nearby, one declines and blocks', async () => {
  const LAT = 40.7128, LON = -74.006;
  const host = phone('host');
  const guests = [phone('g1'), phone('g2'), phone('g3')];
  const outside = phone('outside');
  await host.goVisible({ description: 'Red jacket', lat: LAT, lon: LON });
  for (const [i, g] of guests.entries()) await g.goVisible({ lat: LAT + (5 + i * 5) * M, lon: LON });
  await outside.goVisible({ lat: LAT + 1000 * M, lon: LON });

  const r = await host.call('POST', '/v1/requests', { to: 'everyone', text: 'Whose dog is outside?' });
  assert.equal(r.status, 201);
  assert.equal(r.body.sent, 3);
  assert.equal((await outside.inbox()).incoming.length, 0);

  // A second broadcast right away hits the cooldown, with Retry-After.
  const again = await host.call('POST', '/v1/requests', { to: 'everyone', text: 'Anyone?' });
  assert.equal(again.status, 429);
  assert.equal(again.body.error, 'broadcast_cooldown');
  assert.ok(Number(again.headers.get('retry-after')) > 100);

  const [g1, g2] = guests;
  const id1 = (await g1.inbox()).incoming[0].id;
  const id2 = (await g2.inbox()).incoming[0].id;
  assert.equal((await g1.call('POST', `/v1/requests/${id1}/accept`)).status, 200);
  assert.equal((await g2.call('POST', `/v1/requests/${id2}/decline`, { block: true })).body.blocked, true);

  const statuses = (await host.inbox()).sent.map((s) => s.status).sort();
  assert.deepEqual(statuses, ['accepted', 'declined', 'pending']);
  assert.equal((await host.nearby()).some((p) => p.id === g2.id), false);
  assert.equal((await g2.nearby()).some((p) => p.id === host.id), false);
  for (const p of [host, ...guests, outside]) await p.goHidden();
});

test('abuse: the content filter, reports, and the admin endpoints', async () => {
  const LAT = 51.5072, LON = -0.1276;
  const bully = phone('bully');
  await bully.goVisible({ lat: LAT, lon: LON });
  const victims = [phone('v1'), phone('v2'), phone('v3')];
  for (const v of victims) await v.goVisible({ lat: LAT + 10 * M, lon: LON });

  const rude = await bully.call('POST', '/v1/requests', { to: victims[0].id, text: 'f.u.c.k off' });
  assert.equal(rude.status, 422);
  assert.equal(rude.body.error, 'blocked_content');

  // Without the admin token the admin API doesn't exist.
  assert.equal((await fetch(base + '/admin/reports')).status, 404);

  for (const v of victims) {
    const rep = await v.call('POST', '/v1/reports', { personId: bully.id, reason: 'harassment', note: 'kept following me' });
    assert.equal(rep.status, 201);
  }
  // Three reports from different people suspend the bully.
  assert.equal((await bully.call('GET', '/v1/me')).status, 401);
  const comeback = await bully.call('POST', '/v1/sessions', {});
  assert.equal(comeback.status, 403);
  assert.equal(comeback.body.error, 'suspended');

  const list = await fetch(base + '/admin/reports', { headers: { authorization: `Bearer ${ADMIN}` } }).then((r) => r.json());
  const mine = list.reports.filter((r) => r.target.id === bully.id);
  assert.equal(mine.length, 3);
  assert.ok(mine.every((r) => r.suspended === 'reports'));
  // Reports are logged for moderators even with no webhook configured.
  await waitFor(async () => /report/i.test(output), { what: 'report log line' });
  for (const v of victims) await v.goHidden();
});

test('App Review demo mode from the real environment variable', async () => {
  const reviewer = phone('reviewer');
  await reviewer.goVisible({ description: DEMO, lat: 37.3349, lon: -122.009 });
  assert.equal((await reviewer.call('GET', '/v1/me')).body.description, 'App Review');
  const bot = (await reviewer.nearby()).find((p) => p.nickname === 'Test Bot');
  assert.ok(bot, 'Test Bot is nearby');
  await reviewer.call('POST', '/v1/requests', { to: bot.id, text: 'Hello?' });
  const box = await reviewer.inbox();
  assert.equal(box.sent[0].status, 'accepted');
  assert.ok(box.incoming.some((r) => r.isReply && r.from.nickname === 'Test Bot'));
  await reviewer.goHidden();
  // The bot leaves with its reviewer.
  const other = phone('other');
  await other.goVisible({ lat: 37.3349, lon: -122.009 });
  assert.equal((await other.nearby()).some((p) => p.nickname === 'Test Bot'), false);
  await other.goHidden();
});

test('scripts/fake-person.mjs greets you, accepts and replies', async () => {
  const LAT = 48.8566, LON = 2.3522;
  const me = phone('me');
  await me.goVisible({ description: 'Blue bike', lat: LAT, lon: LON });

  let log = '';
  const bot = spawn(process.execPath, [fakePerson, base, String(LAT), String(LON)], {
    env: { PATH: process.env.PATH, FAKE_TICK_MS: '150' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(bot);
  bot.stdout.on('data', (d) => { log += d; });
  bot.stderr.on('data', (d) => { log += d; });

  const keepFresh = setInterval(() => me.moveTo(LAT, LON).catch(() => {}), 1000);
  try {
    const req = await waitFor(async () => (await me.inbox()).incoming.find((r) => r.from.nickname === 'Test Bot'),
      { what: 'the fake person to ask to message me' });
    assert.equal(req.from.description, 'Grey Tesla');
    const opened = await me.call('POST', `/v1/requests/${req.id}/accept`);
    assert.match(opened.body.text, /Test Bot/);

    const botId = (await me.nearby()).find((p) => p.nickname === 'Test Bot').id;
    await me.call('POST', '/v1/requests', { to: botId, text: 'Hi bot' });
    await waitFor(async () => (await me.inbox()).sent.find((s) => s.to.id === botId && s.status === 'accepted'),
      { what: 'the fake person to accept' });
    const reply = await waitFor(async () => (await me.inbox()).incoming.find((r) => r.isReply),
      { what: 'the fake person to reply' });
    assert.equal(reply.text, 'Got it, thanks! 👍');
  } finally {
    clearInterval(keepFresh);
  }

  // Stopping the script takes the bot off the map.
  const exited = new Promise((r) => bot.on('exit', r));
  bot.kill('SIGTERM');
  await exited;
  assert.match(log, /hidden, bye/);
  assert.equal((await me.nearby()).some((p) => p.nickname === 'Test Bot'), false);
  await me.goHidden();
});

test('SIGTERM shuts the server down cleanly', async () => {
  const exited = new Promise((r) => proc.on('exit', (code) => r(code)));
  proc.kill('SIGTERM');
  assert.equal(await exited, 0);
});
