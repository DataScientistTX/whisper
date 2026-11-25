// Whisper's HTTP API: routing, auth and push fan-out on top of state.js.

import { timingSafeEqual } from 'node:crypto';
import { createState, LIMITS } from './state.js';
import { HttpError } from './errors.js';
import { readJson, send } from './http.js';
import { requestPushPayload, acceptedPushPayload } from './push.js';
import { createDemo } from './demo.js';
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export { LIMITS, REPORT_REASONS, createState } from './state.js';

export function createApp({ now, push, filter, adminToken, onReport, demoCode, log = console } = {}) {
  const state = createState({ now, filter });
  const reportSink = onReport ?? (async () => {});

  function isAdmin(header) {
    if (!adminToken) return false;
    const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
    if (!m) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(adminToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const pusher = push ?? { send: async () => ({ ok: false, reason: 'disabled' }) };

  async function notify(session, payload, collapseId) {
    if (!session?.pushToken) return;
    const result = await pusher.send(session.pushToken, payload, { collapseId });
    if (result?.status === 410 || result?.reason === 'BadDeviceToken' || result?.reason === 'Unregistered') {
      session.pushToken = null;
    }
  }

  // Fixed one-minute window per IP across every endpoint.
  const ipWindows = new Map(); // ip -> { start, count }
  const clock = now ?? (() => Date.now());
  function limitIp(ip) {
    const t = clock();
    let w = ipWindows.get(ip);
    if (!w || t - w.start >= 60_000) {
      if (ipWindows.size > 50_000) for (const [k, v] of ipWindows) if (t - v.start >= 60_000) ipWindows.delete(k);
      w = { start: t, count: 0 };
      ipWindows.set(ip, w);
    }
    if (++w.count > LIMITS.requestsPerIpPerMinute) {
      throw new HttpError(429, 'rate_limited', 'Too many requests', Math.ceil((w.start + 60_000 - t) / 1000));
    }
  }

  const demo = createDemo({
    state,
    code: demoCode,
    now,
    onRequest: (owner, r) => notify(owner, requestPushPayload(r), r.id).catch(() => {}),
    onAccepted: (sender, r) => notify(sender, acceptedPushPayload(r), `acc-${r.id}`).catch(() => {}),
  });

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method;
    const ip = (req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress ?? '').trim();
    if (path !== '/health') limitIp(ip);

    if (path === '/health' && method === 'GET') {
      return send(res, 200, { ok: true });
    }
    if (path === '/' && method === 'GET') {
      return send(res, 200, { name: 'whisper', version: VERSION });
    }

    if (path === '/v1/sessions' && method === 'POST') {
      const body = await readJson(req);
      return send(res, 201, state.createSession(body, ip));
    }

    if (path.startsWith('/admin/')) {
      if (!isAdmin(req.headers.authorization)) throw new HttpError(404, 'not_found');
      if (path === '/admin/reports' && method === 'GET') {
        return send(res, 200, { reports: [...state.reports].reverse() });
      }
      const sm = /^\/admin\/sessions\/([A-Za-z0-9_-]+)\/suspend$/.exec(path);
      if (sm && method === 'POST') {
        return send(res, 200, { suspended: state.suspend(sm[1], 'admin') });
      }
      throw new HttpError(404, 'not_found');
    }

    if (!path.startsWith('/v1/')) throw new HttpError(404, 'not_found');
    const me = state.authenticate(req.headers.authorization);

    // Anything the user does counts as activity. Background location reports and
    // background polling don't, so a forgotten session ends after 15 minutes.
    const foreground = req.headers['x-whisper-foreground'] === '1';
    const isPassive = (path === '/v1/me/location' && method === 'PUT') || (method === 'GET' && !foreground);
    if (!isPassive) state.touch(me);

    if (path === '/v1/me') {
      if (method === 'GET') return send(res, 200, state.publicSelf(me));
      if (method === 'PATCH') return send(res, 200, state.updateMe(me, await readJson(req)));
      if (method === 'DELETE') {
        state.eraseSession(me.id);
        demo.removeBotFor(me.id);
        return send(res, 200, { ok: true });
      }
    }
    if (path === '/v1/me/location' && method === 'PUT') {
      const result = state.setLocation(me, await readJson(req));
      demo.afterLocation(me);
      return send(res, 200, result);
    }
    if (path === '/v1/nearby' && method === 'GET') {
      return send(res, 200, state.nearby(me, url.searchParams.get('radius') ?? undefined));
    }
    if (path === '/v1/blocks' && method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, state.blockPerson(me, body.personId));
    }
    if (path === '/v1/reports' && method === 'POST') {
      const { entry, suspended } = state.report(me, await readJson(req));
      reportSink(entry, { suspended }).catch((e) => log.error?.('[report] sink failed', e?.message));
      return send(res, 201, { ok: true, blocked: true });
    }
    if (path === '/v1/inbox' && method === 'GET') {
      return send(res, 200, state.inbox(me));
    }
    if (path === '/v1/requests' && method === 'POST') {
      const { created, skipped } = state.sendRequest(me, await readJson(req));
      for (const r of created) notify(state.sessions.get(r.to), requestPushPayload(r), r.id).catch(() => {});
      demo.afterSend(created);
      return send(res, 201, {
        sent: created.length,
        skipped,
        requests: created.map((r) => ({ id: r.id, to: { id: r.to, nickname: r.toNickname, description: r.toDescription }, status: r.status })),
      });
    }
    const m = /^\/v1\/requests\/([A-Za-z0-9_-]+)\/(accept|decline)$/.exec(path);
    if (m && method === 'POST') {
      const [, id, action] = m;
      if (action === 'accept') {
        const { r, first } = state.accept(me, id);
        if (first && r.from) notify(state.sessions.get(r.from), acceptedPushPayload(r), `acc-${r.id}`).catch(() => {});
        return send(res, 200, {
          id: r.id,
          status: r.status,
          text: r.text,
          from: { id: r.from, nickname: r.fromNickname, description: r.fromDescription },
        });
      }
      const body = await readJson(req);
      return send(res, 200, state.decline(me, id, { block: body.block === true }));
    }
    throw new HttpError(404, 'not_found');
  }

  async function handler(req, res) {
    try {
      await route(req, res);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.retryAfterSec) res.setHeader('retry-after', String(e.retryAfterSec));
        return send(res, e.status, { error: e.code, message: e.message, ...(e.retryAfterSec ? { retryAfter: e.retryAfterSec } : {}) });
      }
      log.error?.('[whisper] internal error', e?.stack ?? e);
      send(res, 500, { error: 'internal' });
    }
  }

  const sweep = () => { state.sweep(); demo.sweep(); };
  return { handler, state, sweep, demo };
}
