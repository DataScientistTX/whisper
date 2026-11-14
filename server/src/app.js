// Whisper server core: in-memory state plus the HTTP API. Nothing is written to
// disk and neither locations nor message text are ever logged.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { distance, bearing, directionLabel, roughDistance, validCoord } from './geo.js';
import { randomNickname } from './names.js';
import { createFilter } from './filter.js';

export const LIMITS = {
  sessionMaxMs: 3 * 60 * 60 * 1000,      // a session lives at most 3 hours
  inactivityMs: 15 * 60 * 1000,          // ... or until 15 minutes without the user doing anything
  locationFreshMs: 30 * 1000,            // people whose last fix is older are not "nearby"
  requestTtlMs: 15 * 60 * 1000,          // unanswered requests expire
  maxPendingPerPair: 3,                  // unanswered requests from one person to another
  maxSendsPerMinute: 6,
  maxTextLength: 140,
  maxNicknameLength: 24,
  maxDescriptionLength: 40,
  radii: { close: 40, normal: 80, wide: 150 },
  maxRadius: 150,
  rangeSlackM: 20,                       // GPS wobble allowance when sending
  sessionsPerIpPer10Min: 30,
  maxBodyBytes: 8 * 1024,
  reportsToSuspend: 3,                   // distinct people reporting someone suspends them
  suspensionMs: 24 * 60 * 60 * 1000,     // ... and bans their device and network for a day
  maxStoredReports: 500,
  maxReportNoteLength: 200,
};

export const REPORT_REASONS = ['harassment', 'threat', 'sexual', 'hate', 'spam', 'other'];

class HttpError extends Error {
  constructor(status, code, message) { super(message ?? code); this.status = status; this.code = code; }
}

const hashToken = (t) => createHash('sha256').update(t).digest('hex');
const newId = (bytes = 9) => randomBytes(bytes).toString('base64url');
const graphemes = (s) => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length;

function cleanString(value, max, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_' + field);
  const s = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (graphemes(s) > max) throw new HttpError(400, field + '_too_long', `${field} is limited to ${max} characters`);
  return s;
}

export function createState({ now = () => Date.now(), filter = createFilter() } = {}) {
  const sessions = new Map(); // id -> session
  const tokens = new Map();   // sha256(token) -> id
  const requests = new Map(); // id -> request
  const ipHits = new Map();   // ip -> [timestamps]
  // A declined request is deleted at once (text included). The sender still sees
  // "declined" through this short-lived, text-free tombstone.
  const tombstones = new Map(); // requestId -> { from, toNickname, toDescription, createdAt, at }
  const bans = new Map();       // 'push:<token>' | 'ip:<hash>' -> until (ms)
  const reports = [];           // newest last, capped at LIMITS.maxStoredReports

  const ipKey = (ip) => 'ip:' + createHash('sha256').update('whisper-ip:' + ip).digest('hex').slice(0, 32);
  const isBanned = (key) => key && (bans.get(key) ?? 0) > now();
  function assertNotBanned({ ip, pushToken }) {
    if ((ip && isBanned(ipKey(ip))) || (pushToken && isBanned('push:' + pushToken))) {
      throw new HttpError(403, 'suspended', 'This device is suspended after reports from other people. Try again tomorrow.');
    }
  }
  function assertClean(value, field) {
    if (value && filter.isBlocked(value)) {
      throw new HttpError(422, 'blocked_content', field === 'text'
        ? "That message can't be sent. Please keep it friendly."
        : `That ${field} isn't allowed. Please pick something else.`);
    }
    return value;
  }

  function eraseSession(id) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    tokens.delete(s.tokenHash);
    for (const [rid, r] of requests) {
      // Pending requests involving this person disappear with them (their text too).
      // Accepted messages stay with the recipient until the recipient leaves.
      if (r.to === id || (r.from === id && r.status !== 'accepted')) requests.delete(rid);
      else if (r.from === id) r.from = null;
    }
    for (const other of sessions.values()) other.blocks.delete(id);
    for (const [rid, x] of tombstones) if (x.from === id) tombstones.delete(rid);
  }

  function sweep() {
    const t = now();
    for (const s of sessions.values()) {
      if (t - s.createdAt > LIMITS.sessionMaxMs || t - s.lastActive > LIMITS.inactivityMs) eraseSession(s.id);
    }
    for (const [rid, r] of requests) {
      if (r.status === 'pending' && t - r.createdAt > LIMITS.requestTtlMs) requests.delete(rid);
    }
    for (const [key, until] of bans) if (until <= t) bans.delete(key);
    for (const [ip, hits] of ipHits) {
      const kept = hits.filter((h) => t - h < 10 * 60 * 1000);
      if (kept.length) ipHits.set(ip, kept); else ipHits.delete(ip);
    }
  }

  const isBlocked = (a, b) => a.blocks.has(b.id) || b.blocks.has(a.id);
  const hasFreshLocation = (s) => s.loc && now() - s.loc.at <= LIMITS.locationFreshMs;

  function publicSelf(s) {
    return {
      id: s.id,
      nickname: s.nickname,
      description: s.description,
      radius: s.radius,
      expiresAt: new Date(Math.min(s.createdAt + LIMITS.sessionMaxMs, s.lastActive + LIMITS.inactivityMs)).toISOString(),
      hardExpiresAt: new Date(s.createdAt + LIMITS.sessionMaxMs).toISOString(),
    };
  }

  function createSession({ nickname, description, pushToken } = {}, ip = '') {
    const t = now();
    const push = validPushToken(pushToken);
    assertNotBanned({ ip, pushToken: push });
    const hits = (ipHits.get(ip) ?? []).filter((h) => t - h < 10 * 60 * 1000);
    if (hits.length >= LIMITS.sessionsPerIpPer10Min) throw new HttpError(429, 'rate_limited', 'Too many new sessions, try again later');
    hits.push(t);
    ipHits.set(ip, hits);

    const token = randomBytes(32).toString('base64url');
    const s = {
      id: newId(),
      tokenHash: hashToken(token),
      nickname: assertClean(cleanString(nickname, LIMITS.maxNicknameLength, 'nickname'), 'nickname') || randomNickname(),
      description: assertClean(cleanString(description, LIMITS.maxDescriptionLength, 'description'), 'description') ?? '',
      pushToken: push,
      ipKey: ip ? ipKey(ip) : null,
      reportedBy: new Set(),
      loc: null,
      radius: LIMITS.radii.normal,
      createdAt: t,
      lastActive: t,
      blocks: new Set(),
      sends: [],
    };
    sessions.set(s.id, s);
    tokens.set(s.tokenHash, s.id);
    return { token, ...publicSelf(s) };
  }

  function validPushToken(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !/^[0-9a-fA-F]{32,200}$/.test(v)) throw new HttpError(400, 'invalid_push_token');
    return v.toLowerCase();
  }

  function authenticate(authHeader) {
    const m = /^Bearer\s+(\S+)$/i.exec(authHeader ?? '');
    if (!m) throw new HttpError(401, 'unauthorized', 'Missing session token');
    const id = tokens.get(hashToken(m[1]));
    const s = id && sessions.get(id);
    if (!s) throw new HttpError(401, 'session_expired', 'Session not found or expired');
    const t = now();
    if (t - s.createdAt > LIMITS.sessionMaxMs || t - s.lastActive > LIMITS.inactivityMs) {
      eraseSession(s.id);
      throw new HttpError(401, 'session_expired', 'Session expired');
    }
    return s;
  }

  const touch = (s) => { s.lastActive = now(); };

  function updateMe(s, body) {
    if ('nickname' in body) s.nickname = assertClean(cleanString(body.nickname, LIMITS.maxNicknameLength, 'nickname'), 'nickname') || s.nickname;
    if ('description' in body) s.description = assertClean(cleanString(body.description, LIMITS.maxDescriptionLength, 'description'), 'description') ?? '';
    if ('pushToken' in body) {
      const push = validPushToken(body.pushToken);
      if (push && isBanned('push:' + push)) {
        eraseSession(s.id);
        throw new HttpError(403, 'suspended', 'This device is suspended after reports from other people. Try again tomorrow.');
      }
      s.pushToken = push;
    }
    if ('radius' in body) s.radius = parseRadius(body.radius);
    return publicSelf(s);
  }

  function parseRadius(v) {
    if (v === undefined || v === null || v === '') return LIMITS.radii.normal;
    if (typeof v === 'string' && LIMITS.radii[v]) return LIMITS.radii[v];
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, 'invalid_radius');
    return Math.min(Math.round(n), LIMITS.maxRadius);
  }

  function setLocation(s, { lat, lon, accuracy, heading }) {
    if (!validCoord(lat, lon)) throw new HttpError(400, 'invalid_location');
    s.loc = {
      lat, lon,
      accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
      heading: Number.isFinite(heading) && heading >= 0 && heading < 360 ? heading : null,
      at: now(),
    };
    return { ok: true };
  }

  function peopleInRange(s, radius) {
    if (!hasFreshLocation(s)) return [];
    const out = [];
    for (const o of sessions.values()) {
      if (o.id === s.id || !hasFreshLocation(o) || isBlocked(s, o)) continue;
      const d = distance(s.loc, o.loc);
      if (d <= radius) out.push({ o, d });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  function nearby(s, radiusParam) {
    if (radiusParam !== undefined && radiusParam !== null) s.radius = parseRadius(radiusParam);
    if (!s.loc) throw new HttpError(409, 'no_location', 'Send your location first');
    return {
      radius: s.radius,
      people: peopleInRange(s, s.radius).map(({ o, d }) => ({
        id: o.id,
        nickname: o.nickname,
        description: o.description,
        distance: roughDistance(d),
        direction: directionLabel(bearing(s.loc, o.loc), s.loc.heading),
      })),
    };
  }

  function sendRequest(s, { to, text }) {
    const clean = cleanString(text, LIMITS.maxTextLength, 'text');
    if (!clean) throw new HttpError(400, 'empty_text', 'Message is empty');
    assertClean(clean, 'text');
    if (!s.loc) throw new HttpError(409, 'no_location', 'Send your location first');
    const t = now();
    s.sends = s.sends.filter((x) => t - x < 60 * 1000);
    if (s.sends.length >= LIMITS.maxSendsPerMinute) throw new HttpError(429, 'rate_limited', 'Slow down: 6 sends a minute');

    const inRange = peopleInRange(s, Math.min(s.radius + LIMITS.rangeSlackM, LIMITS.maxRadius + LIMITS.rangeSlackM));
    let targets;
    if (to === 'everyone') {
      targets = inRange.map((x) => x.o);
      if (!targets.length) throw new HttpError(404, 'nobody_nearby', 'Nobody is nearby');
    } else {
      if (typeof to !== 'string') throw new HttpError(400, 'invalid_target');
      const hit = inRange.find((x) => x.o.id === to);
      if (!hit) throw new HttpError(404, 'not_nearby', 'That person is no longer nearby');
      targets = [hit.o];
    }

    const pendingFor = (o) => {
      let n = 0;
      for (const r of requests.values()) if (r.from === s.id && r.to === o.id && r.status === 'pending') n++;
      return n;
    };
    const eligible = targets.filter((o) => pendingFor(o) < LIMITS.maxPendingPerPair);
    if (!eligible.length) {
      throw new HttpError(429, 'too_many_pending', 'Wait for an answer before sending more');
    }

    s.sends.push(t);
    const created = eligible.map((o) => {
      const r = {
        id: newId(),
        from: s.id,
        to: o.id,
        fromNickname: s.nickname,
        fromDescription: s.description,
        toNickname: o.nickname,
        toDescription: o.description,
        text: clean,
        status: 'pending',
        broadcast: to === 'everyone',
        createdAt: t,
        decidedAt: null,
      };
      requests.set(r.id, r);
      return r;
    });
    return { created, skipped: targets.length - eligible.length };
  }

  function getRequestFor(s, id) {
    const r = requests.get(id);
    if (!r || r.to !== s.id) throw new HttpError(404, 'not_found', 'Request not found');
    return r;
  }

  function accept(s, id) {
    const r = getRequestFor(s, id);
    const first = r.status === 'pending';
    if (first) {
      r.status = 'accepted';
      r.decidedAt = now();
    }
    return { r, first };
  }

  function decline(s, id, { block = false } = {}) {
    const r = getRequestFor(s, id);
    if (r.status === 'accepted') throw new HttpError(409, 'already_accepted');
    const fromId = r.from;
    requests.delete(r.id); // declined text is deleted right away
    if (block && fromId) blockPerson(s, fromId);
    return { fromId, blocked: Boolean(block && fromId) };
  }

  // Blocking hides both people from each other and drops anything pending between them.
  function blockPerson(s, otherId) {
    if (typeof otherId !== 'string' || otherId === s.id) throw new HttpError(400, 'invalid_person');
    s.blocks.add(otherId);
    for (const [rid, x] of requests) {
      if (x.status === 'pending' && ((x.from === otherId && x.to === s.id) || (x.from === s.id && x.to === otherId))) requests.delete(rid);
    }
    return { ok: true };
  }

  // Ends someone's session and bans their device (push token) and network for a day.
  function suspend(id, reason) {
    const target = sessions.get(id);
    if (!target) return false;
    const until = now() + LIMITS.suspensionMs;
    if (target.pushToken) bans.set('push:' + target.pushToken, until);
    if (target.ipKey) bans.set(target.ipKey, until);
    eraseSession(id);
    for (const r of reports) if (r.target.id === id) r.suspended = reason;
    return true;
  }

  // A report always blocks the person too. Reports are the one place message
  // text is kept: the reporter chose to share it so a moderator can review it.
  function report(s, { requestId, personId, reason, note } = {}) {
    if (!REPORT_REASONS.includes(reason)) throw new HttpError(400, 'invalid_reason', `reason must be one of: ${REPORT_REASONS.join(', ')}`);
    const cleanNote = cleanString(note, LIMITS.maxReportNoteLength, 'note') ?? '';
    let target;
    let text = null;
    if (requestId !== undefined) {
      const r = requests.get(requestId);
      if (!r || r.to !== s.id || !r.from) throw new HttpError(404, 'not_found', 'Request not found');
      target = { id: r.from, nickname: r.fromNickname, description: r.fromDescription };
      if (r.status === 'accepted') text = r.text;
      else requests.delete(r.id); // an unread request from someone you report is dropped unread
    } else {
      const o = typeof personId === 'string' && personId !== s.id ? sessions.get(personId) : null;
      if (!o) throw new HttpError(404, 'not_found', 'That person is gone');
      target = { id: o.id, nickname: o.nickname, description: o.description };
    }
    blockPerson(s, target.id);

    const entry = {
      id: newId(),
      at: new Date(now()).toISOString(),
      reason,
      note: cleanNote,
      text,
      target,
      reporterId: s.id,
      suspended: null,
    };
    reports.push(entry);
    if (reports.length > LIMITS.maxStoredReports) reports.splice(0, reports.length - LIMITS.maxStoredReports);

    const reported = sessions.get(target.id);
    let suspended = false;
    if (reported) {
      reported.reportedBy.add(s.id);
      if (reported.reportedBy.size >= LIMITS.reportsToSuspend) suspended = suspend(reported.id, 'reports');
    }
    return { entry, suspended };
  }

  function declineWithTombstone(s, id, opts) {
    const r = getRequestFor(s, id);
    const snap = { from: r.from, toNickname: r.toNickname, toDescription: r.toDescription, createdAt: r.createdAt, at: now() };
    const res = decline(s, id, opts);
    if (snap.from) tombstones.set(id, snap);
    return res;
  }

  function inbox(s) {
    const t = now();
    for (const [id, x] of tombstones) if (t - x.at > LIMITS.requestTtlMs) tombstones.delete(id);
    const incoming = [];
    const sent = [];
    for (const r of requests.values()) {
      if (r.to === s.id) {
        incoming.push({
          id: r.id,
          from: { id: r.from, nickname: r.fromNickname, description: r.fromDescription },
          status: r.status,
          text: r.status === 'accepted' ? r.text : null,
          broadcast: r.broadcast,
          createdAt: new Date(r.createdAt).toISOString(),
        });
      } else if (r.from === s.id) {
        sent.push({
          id: r.id,
          to: { id: r.to, nickname: r.toNickname, description: r.toDescription },
          status: r.status,
          text: r.text,
          broadcast: r.broadcast,
          createdAt: new Date(r.createdAt).toISOString(),
        });
      }
    }
    for (const [id, x] of tombstones) {
      if (x.from === s.id) {
        sent.push({
          id,
          to: { id: null, nickname: x.toNickname, description: x.toDescription },
          status: 'declined',
          text: null,
          broadcast: false,
          createdAt: new Date(x.createdAt).toISOString(),
        });
      }
    }
    const byNewest = (a, b) => (a.createdAt < b.createdAt ? 1 : -1);
    return { me: publicSelf(s), incoming: incoming.sort(byNewest), sent: sent.sort(byNewest) };
  }

  return {
    sessions, requests, tombstones, bans, reports,
    createSession, authenticate, touch, updateMe, setLocation, nearby,
    sendRequest, accept, decline: declineWithTombstone, inbox, eraseSession, sweep, publicSelf,
    blockPerson, report, suspend,
  };
}

// ---------------------------------------------------------------- HTTP layer

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMITS.maxBodyBytes) { reject(new HttpError(413, 'body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(new HttpError(400, 'invalid_json')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function requestPushPayload(r) {
  const who = r.fromDescription ? `${r.fromNickname} · ${r.fromDescription}` : r.fromNickname;
  return {
    aps: {
      alert: { title: 'Whisper', body: `${who} wants to send you a message` },
      sound: 'default',
      category: 'WHISPER_REQUEST',
      'thread-id': 'whisper-requests',
    },
    kind: 'request',
    requestId: r.id,
  };
}

function acceptedPushPayload(r) {
  const who = r.toDescription ? `${r.toNickname} · ${r.toDescription}` : r.toNickname;
  return {
    aps: { alert: { title: 'Whisper', body: `${who} accepted your message` }, sound: 'default', 'thread-id': 'whisper-sent' },
    kind: 'accepted',
    requestId: r.id,
  };
}

export function createApp({ now, push, filter, adminToken, onReport, log = console } = {}) {
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

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method;

    if (path === '/health' && method === 'GET') {
      return send(res, 200, { ok: true });
    }
    if (path === '/' && method === 'GET') {
      return send(res, 200, { name: 'whisper', version: '0.2.0' });
    }

    if (path === '/v1/sessions' && method === 'POST') {
      const body = await readJson(req);
      const ip = (req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress ?? '').trim();
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
      if (method === 'DELETE') { state.eraseSession(me.id); return send(res, 200, { ok: true }); }
    }
    if (path === '/v1/me/location' && method === 'PUT') {
      return send(res, 200, state.setLocation(me, await readJson(req)));
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
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
      log.error?.('[whisper] internal error', e?.stack ?? e);
      send(res, 500, { error: 'internal' });
    }
  }

  return { handler, state };
}
