import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, M } from './helpers.js';

let s;
before(async () => { s = await startServer({ demoCode: 'Review-7731' }); });
after(async () => { await s.close(); });

const LAT = 30.2672, LON = -97.7431;
const tick = () => new Promise((r) => setTimeout(r, 20));

async function acceptedPair() {
  const a = await s.person({ nickname: 'Blue Fox', description: 'White Toyota', lat: LAT, lon: LON });
  const b = await s.person({ nickname: 'Red Owl', description: 'Black Jeep', lat: LAT + 20 * M, lon: LON });
  const sent = await s.call('POST', '/v1/requests', { token: a.token, body: { to: b.id, text: 'Your headlights are off' } });
  const id = sent.body.requests[0].id;
  await s.call('POST', `/v1/requests/${id}/accept`, { token: b.token });
  return { a, b, id };
}
const bye = (...people) => Promise.all(people.map((p) => s.call('DELETE', '/v1/me', { token: p.token })));

test('the recipient can reply once, and the reply arrives already accepted', async () => {
  const { a, b, id } = await acceptedPair();
  const before = await s.call('GET', '/v1/inbox', { token: b.token });
  assert.equal(before.body.incoming[0].canReply, true);

  s.pushes.length = 0;
  const r = await s.call('POST', '/v1/requests', { token: b.token, body: { replyTo: id, text: 'Thanks!' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.sent, 1);
  assert.equal(r.body.requests[0].status, 'accepted');

  // The push says who replied but not what they said.
  await tick();
  assert.equal(s.pushes.length, 1);
  assert.equal(s.pushes[0].payload.kind, 'reply');
  assert.equal(s.pushes[0].payload.aps.alert.body, 'Red Owl · Black Jeep replied to your message');
  assert.equal(JSON.stringify(s.pushes[0].payload).includes('Thanks'), false);

  const aBox = await s.call('GET', '/v1/inbox', { token: a.token });
  const reply = aBox.body.incoming[0];
  assert.equal(reply.text, 'Thanks!');
  assert.equal(reply.status, 'accepted');
  assert.equal(reply.isReply, true);
  // ... and the original sender can answer the reply in turn.
  assert.equal(reply.canReply, true);

  const bBox = await s.call('GET', '/v1/inbox', { token: b.token });
  assert.equal(bBox.body.incoming[0].canReply, false);
  assert.equal(bBox.body.sent[0].isReply, true);

  const again = await s.call('POST', '/v1/requests', { token: b.token, body: { replyTo: id, text: 'Thanks again' } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_replied');
  await bye(a, b);
});

test('a reply works after the sender drives out of range', async () => {
  const { a, b, id } = await acceptedPair();
  s.advance(5_000);
  await s.call('PUT', '/v1/me/location', { token: a.token, body: { lat: LAT + 400 * M, lon: LON, accuracy: 5 } });
  const r = await s.call('POST', '/v1/requests', { token: b.token, body: { replyTo: id, text: 'Thanks, fixed it' } });
  assert.equal(r.status, 201);
  await bye(a, b);
});

test('replies need an accepted message of your own, and expire', async () => {
  const a = await s.person({ lat: LAT, lon: LON });
  const b = await s.person({ lat: LAT + 10 * M, lon: LON });
  const pending = (await s.call('POST', '/v1/requests', { token: a.token, body: { to: b.id, text: 'hello' } })).body.requests[0].id;

  const notYet = await s.call('POST', '/v1/requests', { token: b.token, body: { replyTo: pending, text: 'hi' } });
  assert.equal(notYet.body.error, 'not_accepted');
  // The sender can't "reply" to their own message to skip the accept step.
  const own = await s.call('POST', '/v1/requests', { token: a.token, body: { replyTo: pending, text: 'read this' } });
  assert.equal(own.status, 404);
  assert.equal((await s.call('POST', '/v1/requests', { token: b.token, body: { replyTo: 'nope', text: 'hi' } })).status, 404);

  await s.call('POST', `/v1/requests/${pending}/accept`, { token: b.token });
  for (let i = 0; i < 2; i++) {
    s.advance(8 * 60_000); // stay active so the sessions outlive the reply window
    for (const p of [a, b]) await s.call('GET', '/v1/inbox', { token: p.token, foreground: true });
  }
  const late = await s.call('POST', '/v1/requests', { token: b.token, body: { replyTo: pending, text: 'hi' } });
  assert.equal(late.status, 410);
  assert.equal(late.body.error, 'reply_expired');
  await bye(a, b);
});

test('replies go through the content filter and the send cap', async () => {
  const { a, b, id } = await acceptedPair();
  const rude = await s.call('POST', '/v1/requests', { token: b.token, body: { replyTo: id, text: 'f.u.c.k you' } });
  assert.equal(rude.status, 422);
  // A rejected reply doesn't use up the one reply.
  assert.equal((await s.call('POST', '/v1/requests', { token: b.token, body: { replyTo: id, text: 'Thanks' } })).status, 201);
  await bye(a, b);
});

test('no replies once either person blocks or leaves', async () => {
  const one = await acceptedPair();
  await s.call('POST', '/v1/blocks', { token: one.a.token, body: { personId: one.b.id } });
  const blocked = await s.call('POST', '/v1/requests', { token: one.b.token, body: { replyTo: one.id, text: 'Thanks' } });
  assert.equal(blocked.status, 404);
  await bye(one.a, one.b);

  const two = await acceptedPair();
  await s.call('DELETE', '/v1/me', { token: two.a.token });
  const box = await s.call('GET', '/v1/inbox', { token: two.b.token });
  assert.equal(box.body.incoming[0].canReply, false);
  const gone = await s.call('POST', '/v1/requests', { token: two.b.token, body: { replyTo: two.id, text: 'Thanks' } });
  assert.equal(gone.body.error, 'gone');
  await bye(two.b);
});

test('a reply can be reported like any message', async () => {
  const { a, b, id } = await acceptedPair();
  const r = await s.call('POST', '/v1/requests', { token: b.token, body: { replyTo: id, text: 'see you around' } });
  const rep = await s.call('POST', '/v1/reports', { token: a.token, body: { requestId: r.body.requests[0].id, reason: 'harassment' } });
  assert.equal(rep.status, 201);
  await tick();
  assert.equal(s.reports.at(-1).report.text, 'see you around');
  await bye(a, b);
});

test('the App Review bot replies to what the reviewer sends', async () => {
  const reviewer = await s.person({ description: 'review-7731', lat: LAT, lon: LON, pushToken: 'cd'.repeat(32) });
  const bot = (await s.call('GET', '/v1/nearby', { token: reviewer.token })).body.people.find((p) => p.nickname === 'Test Bot');
  s.pushes.length = 0;
  await s.call('POST', '/v1/requests', { token: reviewer.token, body: { to: bot.id, text: 'Hello bot' } });
  await tick();
  assert.ok(s.pushes.some((p) => p.payload.kind === 'reply'));
  const box = await s.call('GET', '/v1/inbox', { token: reviewer.token });
  const reply = box.body.incoming.find((r) => r.isReply);
  assert.match(reply.text, /automatic reply/);
  await bye(reviewer);
});
