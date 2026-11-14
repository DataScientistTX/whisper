import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, M } from './helpers.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); });

const LAT = 30.2672, LON = -97.7431;

test('health check', async () => {
  const r = await s.call('GET', '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

test('session gets a random nickname and an anonymous token', async () => {
  const r = await s.call('POST', '/v1/sessions', { body: {} });
  assert.equal(r.status, 201);
  assert.match(r.body.nickname, /^\w+ \w+$/);
  assert.ok(r.body.token.length >= 40);
  const me = await s.call('GET', '/v1/me', { token: r.body.token });
  assert.equal(me.body.id, r.body.id);
  assert.equal((await s.call('GET', '/v1/me', { token: 'nope' })).status, 401);
});

test('nearby shows rough distance and relative direction, never coordinates', async () => {
  const a = await s.person({ nickname: 'Blue Fox', description: 'White Toyota', lat: LAT, lon: LON, heading: 0 });
  const b = await s.person({ nickname: 'Red Owl', description: 'Black Jeep', lat: LAT + 23 * M, lon: LON - 10 * M, heading: 0 });
  const far = await s.person({ nickname: 'Far Away', lat: LAT + 500 * M, lon: LON });
  const r = await s.call('GET', '/v1/nearby?radius=normal', { token: a.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.radius, 80);
  const ids = r.body.people.map((p) => p.id);
  assert.ok(ids.includes(b.id));
  assert.ok(!ids.includes(far.id));
  const bp = r.body.people.find((p) => p.id === b.id);
  assert.equal(bp.description, 'Black Jeep');
  assert.equal(bp.distance % 5, 0);
  assert.ok(bp.distance >= 15 && bp.distance <= 30, `distance ${bp.distance}`);
  assert.equal(bp.direction, 'ahead');
  assert.equal(bp.lat, undefined);
  assert.equal(JSON.stringify(r.body).includes(String(LAT + 23 * M)), false);
  for (const p of [a, b, far]) await s.call('DELETE', '/v1/me', { token: p.token });
});

test('request flow: push hides text, accept releases it, sender is told', async () => {
  const a = await s.person({ nickname: 'Blue Fox', description: 'White Toyota', lat: LAT, lon: LON, pushToken: 'aa'.repeat(32) });
  const b = await s.person({ nickname: 'Red Owl', description: 'Black Jeep', lat: LAT + 20 * M, lon: LON, pushToken: 'bb'.repeat(32) });
  s.pushes.length = 0;

  const sent = await s.call('POST', '/v1/requests', { token: a.token, body: { to: b.id, text: 'Your headlights are off' } });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.sent, 1);
  const reqId = sent.body.requests[0].id;

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.pushes.length, 1);
  assert.equal(s.pushes[0].token, 'bb'.repeat(32));
  assert.equal(s.pushes[0].payload.aps.alert.body, 'Blue Fox · White Toyota wants to send you a message');
  assert.equal(s.pushes[0].payload.aps.category, 'WHISPER_REQUEST');
  assert.equal(JSON.stringify(s.pushes[0].payload).includes('headlights'), false);

  const inboxBefore = await s.call('GET', '/v1/inbox', { token: b.token });
  assert.equal(inboxBefore.body.incoming[0].status, 'pending');
  assert.equal(inboxBefore.body.incoming[0].text, null);

  const acc = await s.call('POST', `/v1/requests/${reqId}/accept`, { token: b.token });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.text, 'Your headlights are off');

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.pushes.length, 2);
  assert.equal(s.pushes[1].token, 'aa'.repeat(32));
  assert.match(s.pushes[1].payload.aps.alert.body, /accepted your message/);

  const aInbox = await s.call('GET', '/v1/inbox', { token: a.token });
  assert.equal(aInbox.body.sent[0].status, 'accepted');

  // Only the recipient can accept.
  assert.equal((await s.call('POST', `/v1/requests/${reqId}/accept`, { token: a.token })).status, 404);
  for (const p of [a, b]) await s.call('DELETE', '/v1/me', { token: p.token });
});

test('decline deletes the text; block hides both people from each other', async () => {
  const a = await s.person({ nickname: 'A', lat: LAT, lon: LON });
  const b = await s.person({ nickname: 'B', lat: LAT + 10 * M, lon: LON });
  const r1 = await s.call('POST', '/v1/requests', { token: a.token, body: { to: b.id, text: 'hello' } });
  const id = r1.body.requests[0].id;

  const dec = await s.call('POST', `/v1/requests/${id}/decline`, { token: b.token, body: { block: true } });
  assert.equal(dec.status, 200);
  assert.equal(dec.body.blocked, true);
  assert.equal(s.state.requests.has(id), false);
  assert.equal((await s.call('GET', '/v1/inbox', { token: a.token })).body.sent[0].status, 'declined');
  assert.equal((await s.call('GET', '/v1/inbox', { token: a.token })).body.sent[0].text, null);

  const aSees = await s.call('GET', '/v1/nearby', { token: a.token });
  const bSees = await s.call('GET', '/v1/nearby', { token: b.token });
  assert.equal(aSees.body.people.some((p) => p.id === b.id), false);
  assert.equal(bSees.body.people.some((p) => p.id === a.id), false);
  assert.equal((await s.call('POST', '/v1/requests', { token: a.token, body: { to: b.id, text: 'again' } })).status, 404);
  for (const p of [a, b]) await s.call('DELETE', '/v1/me', { token: p.token });
});

test('anti-spam: 3 unanswered per person, 6 sends a minute, only people nearby', async () => {
  const a = await s.person({ lat: LAT, lon: LON });
  const b = await s.person({ lat: LAT + 10 * M, lon: LON });
  const far = await s.person({ lat: LAT + 400 * M, lon: LON });
  for (let i = 0; i < 3; i++) {
    assert.equal((await s.call('POST', '/v1/requests', { token: a.token, body: { to: b.id, text: `hi ${i}` } })).status, 201);
  }
  const fourth = await s.call('POST', '/v1/requests', { token: a.token, body: { to: b.id, text: 'hi 4' } });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.error, 'too_many_pending');

  assert.equal((await s.call('POST', '/v1/requests', { token: a.token, body: { to: far.id, text: 'yo' } })).status, 404);

  // Per-minute send cap.
  const c = await s.person({ lat: LAT, lon: LON });
  const others = [];
  for (let i = 0; i < 7; i++) others.push(await s.person({ lat: LAT + (i + 1) * M, lon: LON }));
  for (let i = 0; i < 6; i++) {
    assert.equal((await s.call('POST', '/v1/requests', { token: c.token, body: { to: others[i].id, text: `x ${i}` } })).status, 201);
  }
  const seventh = await s.call('POST', '/v1/requests', { token: c.token, body: { to: others[6].id, text: 'x' } });
  assert.equal(seventh.status, 429);
  assert.equal(seventh.body.error, 'rate_limited');
  s.advance(61_000);
  // Refresh locations after moving the clock.
  for (const p of [c, others[6]]) await s.call('PUT', '/v1/me/location', { token: p.token, body: { lat: LAT, lon: LON } });
  assert.equal((await s.call('POST', '/v1/requests', { token: c.token, body: { to: others[6].id, text: 'x' } })).status, 201);

  // 140 character limit.
  const long = await s.call('POST', '/v1/requests', { token: c.token, body: { to: others[6].id, text: 'x'.repeat(141) } });
  assert.equal(long.body.error, 'text_too_long');
  for (const p of [a, b, far, c, ...others]) await s.call('DELETE', '/v1/me', { token: p.token });
});

test('send to everyone nearby creates one request per person in range', async () => {
  const a = await s.person({ lat: LAT, lon: LON });
  const b = await s.person({ lat: LAT + 10 * M, lon: LON });
  const c = await s.person({ lat: LAT, lon: LON + 30 * M });
  const far = await s.person({ lat: LAT + 300 * M, lon: LON });
  const r = await s.call('POST', '/v1/requests', { token: a.token, body: { to: 'everyone', text: 'Anyone parked in a red Civic? Lights on.' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.sent, 2);
  const farInbox = await s.call('GET', '/v1/inbox', { token: far.token });
  assert.equal(farInbox.body.incoming.length, 0);
  for (const p of [a, b, c, far]) await s.call('DELETE', '/v1/me', { token: p.token });
});

test('sessions end: go hidden, 15 minutes inactive, 3 hours max', async () => {
  const a = await s.person({ lat: LAT, lon: LON });
  const b = await s.person({ lat: LAT + 5 * M, lon: LON });
  await s.call('POST', '/v1/requests', { token: a.token, body: { to: b.id, text: 'bye soon' } });
  assert.equal((await s.call('DELETE', '/v1/me', { token: a.token })).status, 200);
  assert.equal((await s.call('GET', '/v1/me', { token: a.token })).status, 401);
  assert.equal((await s.call('GET', '/v1/inbox', { token: b.token })).body.incoming.length, 0);

  // Background location reports don't keep a session alive.
  const c = await s.person({ lat: LAT, lon: LON });
  s.advance(10 * 60_000);
  await s.call('PUT', '/v1/me/location', { token: c.token, body: { lat: LAT, lon: LON } });
  s.advance(6 * 60_000);
  assert.equal((await s.call('GET', '/v1/me', { token: c.token })).status, 401);

  // Foreground use does, but only up to 3 hours.
  const d = await s.person({ lat: LAT, lon: LON });
  for (let i = 0; i < 18; i++) {
    s.advance(10 * 60_000);
    assert.equal((await s.call('GET', '/v1/inbox', { token: d.token, foreground: true })).status, 200, `step ${i}`);
  }
  s.advance(60_000);
  assert.equal((await s.call('GET', '/v1/inbox', { token: d.token, foreground: true })).status, 401);
  await s.call('DELETE', '/v1/me', { token: b.token });
});

test('input validation', async () => {
  const a = await s.person({});
  assert.equal((await s.call('PUT', '/v1/me/location', { token: a.token, body: { lat: 200, lon: 0 } })).status, 400);
  assert.equal((await s.call('PATCH', '/v1/me', { token: a.token, body: { pushToken: 'not-hex' } })).status, 400);
  assert.equal((await s.call('PATCH', '/v1/me', { token: a.token, body: { description: 'x'.repeat(41) } })).status, 400);
  const ok = await s.call('PATCH', '/v1/me', { token: a.token, body: { nickname: '  Grey   Tesla ', description: 'Silver Model 3' } });
  assert.equal(ok.body.nickname, 'Grey Tesla');
  assert.equal(ok.body.description, 'Silver Model 3');
  assert.equal((await s.call('GET', '/v1/nearby', { token: a.token })).status, 409);
  await s.call('DELETE', '/v1/me', { token: a.token });
});
