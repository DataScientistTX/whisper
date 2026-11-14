import http from 'node:http';
import { createApp } from '../src/app.js';

// Starts the app on a random port with a controllable clock and a fake push sender.
export async function startServer({ adminToken = 'admin-secret' } = {}) {
  const clock = { t: Date.parse('2026-11-14T12:00:00Z') };
  const pushes = [];
  const push = { send: async (token, payload) => { pushes.push({ token, payload }); return { ok: true, status: 200 }; } };
  const reports = [];
  const onReport = async (report, info) => { reports.push({ report, ...info }); };
  const { handler, state } = createApp({ now: () => clock.t, push, adminToken, onReport, log: { error() {}, warn() {}, log() {} } });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { token, body, foreground, ip } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (ip) headers['x-forwarded-for'] = ip;
    if (token) headers.authorization = `Bearer ${token}`;
    if (foreground) headers['x-whisper-foreground'] = '1';
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function person({ nickname, description, lat, lon, heading, pushToken = 'ab'.repeat(32), ip } = {}) {
    const r = await call('POST', '/v1/sessions', { body: { nickname, description, pushToken }, ip });
    const p = { token: r.body.token, id: r.body.id, nickname: r.body.nickname };
    if (lat !== undefined) await call('PUT', '/v1/me/location', { token: p.token, body: { lat, lon, accuracy: 5, heading } });
    return p;
  }

  return {
    base, call, person, pushes, reports, clock, state,
    advance: (ms) => { clock.t += ms; },
    close: () => new Promise((r) => server.close(r)),
  };
}

// About 1 m of latitude.
export const M = 1 / 111_195;
