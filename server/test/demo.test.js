import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, M } from './helpers.js';

let s;
before(async () => { s = await startServer({ demoCode: 'Review-7731' }); });
after(async () => { await s.close(); });

const LAT = 37.3349, LON = -122.009;

test('a reviewer with the demo code gets a Test Bot next to them', async () => {
  const reviewer = await s.person({ description: 'review-7731', lat: LAT, lon: LON, pushToken: 'ab'.repeat(32) });

  // The code is hidden right away.
  const me = await s.call('GET', '/v1/me', { token: reviewer.token });
  assert.equal(me.body.description, 'App Review');

  const near = await s.call('GET', '/v1/nearby', { token: reviewer.token });
  const bot = near.body.people.find((p) => p.nickname === 'Test Bot');
  assert.ok(bot, 'bot is nearby');
  assert.equal(bot.description, 'Grey Tesla');
  assert.ok(bot.distance <= 20);

  // The bot asks to message the reviewer, with a push.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(s.pushes.some((p) => p.token === 'ab'.repeat(32) && /Test Bot · Grey Tesla wants to send you a message/.test(p.payload.aps.alert.body)));
  const inbox = await s.call('GET', '/v1/inbox', { token: reviewer.token });
  assert.equal(inbox.body.incoming[0].from.nickname, 'Test Bot');

  // Anything sent to the bot is accepted immediately.
  const sent = await s.call('POST', '/v1/requests', { token: reviewer.token, body: { to: bot.id, text: 'Your headlights are off' } });
  assert.equal(sent.status, 201);
  const after = await s.call('GET', '/v1/inbox', { token: reviewer.token });
  assert.equal(after.body.sent[0].status, 'accepted');

  // It follows the reviewer as they move.
  s.advance(4000);
  await s.call('PUT', '/v1/me/location', { token: reviewer.token, body: { lat: LAT + 100 * M, lon: LON } });
  const moved = await s.call('GET', '/v1/nearby', { token: reviewer.token });
  assert.ok(moved.body.people.some((p) => p.id === bot.id));

  // And leaves with them.
  await s.call('DELETE', '/v1/me', { token: reviewer.token });
  assert.equal(s.state.sessions.has(bot.id), false);
});

test('without the code, nobody gets a bot', async () => {
  const a = await s.person({ description: 'White Toyota', lat: LAT, lon: LON });
  const near = await s.call('GET', '/v1/nearby', { token: a.token });
  assert.equal(near.body.people.length, 0);
  await s.call('DELETE', '/v1/me', { token: a.token });
});

test('a bot is cleaned up when its reviewer times out', async () => {
  const reviewer = await s.person({ description: 'REVIEW-7731', lat: LAT, lon: LON });
  const botId = [...s.state.sessions.values()].find((x) => x.nickname === 'Test Bot').id;
  s.advance(16 * 60_000);
  s.sweep();
  assert.equal(s.state.sessions.has(reviewer.id), false);
  assert.equal(s.state.sessions.has(botId), false);
});
