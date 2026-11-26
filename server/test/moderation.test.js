import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, M } from './helpers.js';
import { createFilter } from '../src/filter.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); });

const LAT = 30.2672, LON = -97.7431;
const near = (i = 1) => ({ lat: LAT + i * M, lon: LON });
const cleanup = async (...people) => { for (const p of people) await s.call('DELETE', '/v1/me', { token: p.token }); };

test('filter catches evasions without flagging normal words', () => {
  const f = createFilter(['bananas']);
  for (const t of ['fuck you', 'F.U.C.K off', 'fuuuuck', 'y0u b1tch', 'k y s', "you're dead", 'I like BANANAS']) {
    assert.equal(f.isBlocked(t), true, t);
  }
  for (const t of ['Your headlights are off', 'Can I merge in front of you?', 'class act', 'Dickens fan?', 'cocktail bar', 'Scunthorpe', 'hell yes', 'grass']) {
    assert.equal(f.isBlocked(t), false, t);
  }
});

test('objectionable messages, nicknames and descriptions are refused', async () => {
  const a = await s.person({ ...near(0) });
  const b = await s.person({ ...near(5) });
  const r = await s.call('POST', '/v1/requests', { token: a.token, body: { to: b.id, text: 'f u c k you' } });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'blocked_content');
  assert.equal(s.state.requests.size, 0);

  assert.equal((await s.call('POST', '/v1/sessions', { body: { description: 'Big Dick Energy' } })).status, 422);
  assert.equal((await s.call('PATCH', '/v1/me', { token: a.token, body: { nickname: 'Retard' } })).status, 422);
  await cleanup(a, b);
});

test('reporting a message blocks the sender and keeps the text for moderators', async () => {
  const a = await s.person({ nickname: 'Mean Bob', description: 'Grey van', ...near(0) });
  const b = await s.person({ ...near(5) });
  const sent = await s.call('POST', '/v1/requests', { token: a.token, body: { to: b.id, text: 'Nice car, idiot' } });
  const id = sent.body.requests[0].id;
  await s.call('POST', `/v1/requests/${id}/accept`, { token: b.token });

  s.reports.length = 0;
  const rep = await s.call('POST', '/v1/reports', { token: b.token, body: { requestId: id, reason: 'harassment', note: 'rude' } });
  assert.equal(rep.status, 201);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.reports.length, 1);
  assert.equal(s.reports[0].report.text, 'Nice car, idiot');
  assert.equal(s.reports[0].report.target.nickname, 'Mean Bob');
  assert.equal(s.reports[0].report.reason, 'harassment');

  // Blocked both ways now.
  const bSees = await s.call('GET', '/v1/nearby', { token: b.token });
  assert.equal(bSees.body.people.some((p) => p.id === a.id), false);
  const aSees = await s.call('GET', '/v1/nearby', { token: a.token });
  assert.equal(aSees.body.people.some((p) => p.id === b.id), false);

  assert.equal((await s.call('POST', '/v1/reports', { token: b.token, body: { requestId: id, reason: 'bogus' } })).status, 400);
  await cleanup(a, b);
});

test('reporting an unread request drops it without revealing the text', async () => {
  const a = await s.person({ ...near(0) });
  const b = await s.person({ ...near(5) });
  const sent = await s.call('POST', '/v1/requests', { token: a.token, body: { to: b.id, text: 'secret text' } });
  const id = sent.body.requests[0].id;
  s.reports.length = 0;
  await s.call('POST', '/v1/reports', { token: b.token, body: { requestId: id, reason: 'spam' } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.reports[0].report.text, null);
  assert.equal(s.state.requests.has(id), false);
  await cleanup(a, b);
});

test('block from the nearby list', async () => {
  const a = await s.person({ ...near(0) });
  const b = await s.person({ ...near(5) });
  assert.equal((await s.call('POST', '/v1/blocks', { token: a.token, body: { personId: b.id } })).status, 200);
  const bSees = await s.call('GET', '/v1/nearby', { token: b.token });
  assert.equal(bSees.body.people.some((p) => p.id === a.id), false);
  await cleanup(a, b);
});

test('three reports from different people suspend the device and network for a day', async () => {
  const bad = await s.person({ ...near(0), pushToken: 'cd'.repeat(32), ip: '203.0.113.9' });
  const reporters = [];
  for (let i = 1; i <= 3; i++) reporters.push(await s.person({ ...near(i), pushToken: `${i}f`.repeat(32) }));
  for (const r of reporters) {
    await s.call('POST', '/v1/reports', { token: r.token, body: { personId: bad.id, reason: 'harassment' } });
  }
  assert.equal((await s.call('GET', '/v1/me', { token: bad.token })).status, 401);

  const sameDevice = await s.call('POST', '/v1/sessions', { body: { pushToken: 'cd'.repeat(32) }, ip: '198.51.100.1' });
  assert.equal(sameDevice.status, 403);
  assert.equal(sameDevice.body.error, 'suspended');
  const sameNetwork = await s.call('POST', '/v1/sessions', { body: {}, ip: '203.0.113.9' });
  assert.equal(sameNetwork.status, 403);

  s.advance(24 * 60 * 60 * 1000 + 1000);
  s.state.sweep();
  assert.equal((await s.call('POST', '/v1/sessions', { body: { pushToken: 'cd'.repeat(32) }, ip: '203.0.113.9' })).status, 201);
});

test('admin can list reports and suspend; endpoints hidden without the token', async () => {
  assert.equal((await s.call('GET', '/admin/reports')).status, 404);
  assert.equal((await s.call('GET', '/admin/reports', { token: 'wrong' })).status, 404);
  const list = await s.call('GET', '/admin/reports', { token: 'admin-secret' });
  assert.equal(list.status, 200);
  assert.ok(list.body.reports.length >= 1);

  const x = await s.person({ ...near(0), pushToken: 'ee'.repeat(32) });
  const sus = await s.call('POST', `/admin/sessions/${x.id}/suspend`, { token: 'admin-secret' });
  assert.equal(sus.body.suspended, true);
  assert.equal((await s.call('GET', '/v1/me', { token: x.token })).status, 401);
});

test('admin stats are counts only and need the admin token', async () => {
  assert.equal((await s.call('GET', '/admin/stats')).status, 404);
  const a = await s.person({ nickname: 'Stat A', lat: 10, lon: 10 });
  const b = await s.person({ nickname: 'Stat B', lat: 10 + 10 * M, lon: 10 });
  await s.call('POST', '/v1/requests', { token: a.token, body: { to: b.id, text: 'hello there' } });
  await s.call('POST', '/v1/reports', { token: b.token, body: { personId: a.id, reason: 'spam' } });

  const r = await s.call('GET', '/admin/stats', { token: 'admin-secret' });
  assert.equal(r.status, 200);
  assert.ok(r.body.sessions.live >= 2);
  assert.ok(r.body.sessions.withFreshLocation >= 2);
  assert.ok(r.body.reports.byReason.spam >= 1);
  assert.match(r.body.version, /^\d+\.\d+\.\d+$/);
  // Nothing identifying leaks into the stats.
  const raw = JSON.stringify(r.body);
  for (const secret of ['Stat A', 'hello there', a.id, '"lat"']) assert.equal(raw.includes(secret), false, secret);
  for (const p of [a, b]) await s.call('DELETE', '/v1/me', { token: p.token });
});
