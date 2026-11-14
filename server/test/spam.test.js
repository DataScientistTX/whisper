import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, M } from './helpers.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); });

const LAT = 30.2672, LON = -97.7431;
const near = (i = 1) => ({ lat: LAT + i * M, lon: LON });
const cleanup = async (...people) => { for (const p of people) await s.call('DELETE', '/v1/me', { token: p.token }); };
const refresh = async (...people) => { for (const p of people) await s.call('PUT', '/v1/me/location', { token: p.token, body: { lat: p.lat, lon: p.lon } }); };

async function crowd(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const loc = near(i);
    out.push({ ...(await s.person(loc)), ...loc });
  }
  return out;
}

test('message everyone nearby at most once every 2 minutes', async () => {
  const me = { ...(await s.person(near(0))), ...near(0) };
  const others = await crowd(2);
  assert.equal((await s.call('POST', '/v1/requests', { token: me.token, body: { to: 'everyone', text: 'Lights on, red Civic' } })).status, 201);
  const again = await s.call('POST', '/v1/requests', { token: me.token, body: { to: 'everyone', text: 'Anyone?' } });
  assert.equal(again.status, 429);
  assert.equal(again.body.error, 'broadcast_cooldown');
  assert.ok(again.body.retryAfter > 0);
  s.advance(2 * 60_000 + 1000);
  await refresh(me, ...others);
  assert.equal((await s.call('POST', '/v1/requests', { token: me.token, body: { to: 'everyone', text: 'Anyone?' } })).status, 201);
  await cleanup(me, ...others);
});

test('the same text to more than 5 people in 10 minutes is refused, however it is spelled', async () => {
  const me = { ...(await s.person(near(0))), ...near(0) };
  const others = await crowd(7);
  const variants = ['Check out my page', 'CHECK out my page!', 'check  out my page', 'Check out my page.', 'check out my page'];
  for (let i = 0; i < 5; i++) {
    assert.equal((await s.call('POST', '/v1/requests', { token: me.token, body: { to: others[i].id, text: variants[i] } })).status, 201, `send ${i}`);
  }
  s.advance(61_000); // stay under the 6-a-minute cap
  await refresh(me, ...others);
  const sixth = await s.call('POST', '/v1/requests', { token: me.token, body: { to: others[5].id, text: 'check out my PAGE' } });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error, 'duplicate_spam');
  // A different message is fine.
  assert.equal((await s.call('POST', '/v1/requests', { token: me.token, body: { to: others[5].id, text: 'Your trunk is open' } })).status, 201);
  await cleanup(me, ...others);
});

test('5 declines in 10 minutes mutes the sender for 10 minutes', async () => {
  const me = { ...(await s.person(near(0))), ...near(0) };
  const others = await crowd(6);
  for (let i = 0; i < 5; i++) {
    const r = await s.call('POST', '/v1/requests', { token: me.token, body: { to: others[i].id, text: `hello ${i}` } });
    await s.call('POST', `/v1/requests/${r.body.requests[0].id}/decline`, { token: others[i].token });
  }
  s.advance(61_000);
  await refresh(me, ...others);
  const muted = await s.call('POST', '/v1/requests', { token: me.token, body: { to: others[5].id, text: 'hi' } });
  assert.equal(muted.status, 429);
  assert.equal(muted.body.error, 'muted');
  s.advance(10 * 60_000);
  await s.call('GET', '/v1/inbox', { token: me.token, foreground: true });
  await refresh(me, ...others);
  assert.equal((await s.call('POST', '/v1/requests', { token: me.token, body: { to: others[5].id, text: 'hi' } })).status, 201);
  await cleanup(me, ...others);
});

test('one live session per phone', async () => {
  const push = 'ab'.repeat(32);
  const first = await s.person({ ...near(0), pushToken: push });
  const second = await s.person({ ...near(0), pushToken: push });
  assert.equal((await s.call('GET', '/v1/me', { token: first.token })).status, 401);
  assert.equal((await s.call('GET', '/v1/me', { token: second.token })).status, 200);
  await cleanup(second);
});

test('teleporting locations are rejected', async () => {
  const me = await s.person(near(0));
  s.advance(4000);
  const jump = await s.call('PUT', '/v1/me/location', { token: me.token, body: { lat: LAT + 0.05, lon: LON, accuracy: 5 } });
  assert.equal(jump.status, 409);
  assert.equal(jump.body.error, 'implausible_location');
  // Highway speed is fine: ~120 m in 4 s.
  const drive = await s.call('PUT', '/v1/me/location', { token: me.token, body: { lat: LAT + 120 * M, lon: LON, accuracy: 5 } });
  assert.equal(drive.status, 200);
  await cleanup(me);
});

test('per-IP request limit answers 429 with Retry-After', async () => {
  const ip = '192.0.2.50';
  let last;
  for (let i = 0; i < 601; i++) last = await s.call('GET', '/', { ip });
  assert.equal(last.status, 429);
  const res = await fetch(s.base + '/', { headers: { 'x-forwarded-for': ip } });
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  s.advance(60_000);
  assert.equal((await s.call('GET', '/', { ip })).status, 200);
});
