// Whisper's in-memory state: sessions, requests, blocks, reports and bans.
// Nothing is written to disk and neither locations nor message text are ever logged.
// This module knows nothing about HTTP; app.js maps routes onto these functions.

import { randomBytes, createHash } from 'node:crypto';
import { distance, bearing, directionLabel, roughDistance, validCoord } from './geo.js';
import { randomNickname } from './names.js';
import { createFilter } from './filter.js';
import { HttpError } from './errors.js';

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
  // Spam protection. IP-based limits are generous because phones on the same
  // carrier often share one public IP (CGNAT).
  requestsPerIpPerMinute: 600,           // the app makes ~45 calls a minute
  maxSessionsPerIp: 50,                  // live sessions behind one IP
  broadcastCooldownMs: 2 * 60 * 1000,    // one "everyone nearby" send every 2 minutes
  duplicateWindowMs: 10 * 60 * 1000,     // the same text to more than 5 people in 10 minutes is spam
  maxDuplicateRecipients: 5,
  declineWindowMs: 10 * 60 * 1000,       // 5 declines in 10 minutes mutes the sender for 10 minutes
  declinesToMute: 5,
  muteMs: 10 * 60 * 1000,
  maxSpeedMps: 120,                      // faster than ~430 km/h between fixes is a spoofed location
  maxBodyBytes: 8 * 1024,
  reportsToSuspend: 3,                   // distinct people reporting someone suspends them
  suspensionMs: 24 * 60 * 60 * 1000,     // ... and bans their device for a day
  ipSuspensionMs: 60 * 60 * 1000,        // ... and their network for an hour (shared carrier IPs)
  maxStoredReports: 500,
  maxReportNoteLength: 200,
  replyWindowMs: 15 * 60 * 1000,         // you can answer a message you accepted for 15 minutes
};

export const REPORT_REASONS = ['harassment', 'threat', 'sexual', 'hate', 'spam', 'other'];

// Spam fingerprint: case, spacing, punctuation and accents don't make a message new.
const spamKey = (text) => text.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
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
    const ipK = ip ? ipKey(ip) : null;
    if (ipK) {
      let live = 0;
      for (const o of sessions.values()) if (o.ipKey === ipK) live++;
      if (live >= LIMITS.maxSessionsPerIp) throw new HttpError(429, 'rate_limited', 'Too many people on this network right now, try again later', 60);
    }
    hits.push(t);
    ipHits.set(ip, hits);
    // One live session per phone: a new one replaces the old.
    if (push) for (const o of [...sessions.values()]) if (o.pushToken === push) eraseSession(o.id);

    const token = randomBytes(32).toString('base64url');
    const s = {
      id: newId(),
      tokenHash: hashToken(token),
      nickname: assertClean(cleanString(nickname, LIMITS.maxNicknameLength, 'nickname'), 'nickname') || randomNickname(),
      description: assertClean(cleanString(description, LIMITS.maxDescriptionLength, 'description'), 'description') ?? '',
      pushToken: push,
      ipKey: ipK,
      broadcastAt: 0,
      declines: [],
      mutedUntil: 0,
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
      if (push) for (const o of [...sessions.values()]) if (o.id !== s.id && o.pushToken === push) eraseSession(o.id);
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
    if (s.loc) {
      const dt = Math.max((now() - s.loc.at) / 1000, 1);
      const slack = (s.loc.accuracy ?? 10) + (Number.isFinite(accuracy) ? accuracy : 10);
      if (Math.max(distance(s.loc, { lat, lon }) - slack, 0) / dt > LIMITS.maxSpeedMps) {
        throw new HttpError(409, 'implausible_location', 'Location jumped too far too fast');
      }
    }
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

  // Checks shared by every kind of send: the text, the mute and the per-minute cap.
  function checkSend(s, text) {
    const clean = cleanString(text, LIMITS.maxTextLength, 'text');
    if (!clean) throw new HttpError(400, 'empty_text', 'Message is empty');
    assertClean(clean, 'text');
    const t = now();
    if (s.mutedUntil > t) {
      throw new HttpError(429, 'muted', 'Several people declined your messages. Try again in a few minutes.', Math.ceil((s.mutedUntil - t) / 1000));
    }
    s.sends = s.sends.filter((x) => t - x < 60 * 1000);
    if (s.sends.length >= LIMITS.maxSendsPerMinute) {
      throw new HttpError(429, 'rate_limited', 'Slow down: 6 sends a minute', Math.ceil((s.sends[0] + 60 * 1000 - t) / 1000));
    }
    return { clean, t };
  }

  // Why a message can't be answered, or null when it can. Someone who messaged
  // you already chose to talk, so one reply per message is allowed for a while
  // after you accepted it, even once they've driven out of range.
  function replyBlocker(s, r) {
    if (!r || r.to !== s.id) return 'not_found';
    if (r.status !== 'accepted') return 'not_accepted';
    if (r.repliedAt) return 'already_replied';
    if (now() - r.decidedAt > LIMITS.replyWindowMs) return 'reply_expired';
    const other = r.from && sessions.get(r.from);
    if (!other) return 'gone';
    if (isBlocked(s, other)) return 'gone';
    return null;
  }

  const REPLY_ERRORS = {
    not_found: [404, 'Message not found'],
    not_accepted: [409, 'Accept the message before replying'],
    already_replied: [409, "You've already replied to this message"],
    reply_expired: [410, 'Too late to reply to this message'],
    gone: [404, "They've left Whisper"],
  };

  // A reply is delivered straight away (no accept step) because the other
  // person started the conversation. They can still report or block it.
  function sendReply(s, { replyTo, text }) {
    if (typeof replyTo !== 'string') throw new HttpError(400, 'invalid_reply');
    const original = requests.get(replyTo);
    const why = replyBlocker(s, original);
    if (why) throw new HttpError(REPLY_ERRORS[why][0], why, REPLY_ERRORS[why][1]);
    const { clean, t } = checkSend(s, text);
    const other = sessions.get(original.from);
    s.sends.push(t);
    original.repliedAt = t;
    const r = {
      id: newId(),
      from: s.id,
      to: other.id,
      fromNickname: s.nickname,
      fromDescription: s.description,
      toNickname: other.nickname,
      toDescription: other.description,
      text: clean,
      status: 'accepted',
      broadcast: false,
      replyTo: original.id,
      createdAt: t,
      decidedAt: t,
    };
    requests.set(r.id, r);
    return { created: [r], skipped: 0, reply: true };
  }

  function sendRequest(s, body = {}) {
    if (body.replyTo !== undefined && body.replyTo !== null) return sendReply(s, body);
    const { to, text } = body;
    if (!s.loc) throw new HttpError(409, 'no_location', 'Send your location first');
    const { clean, t } = checkSend(s, text);
    if (to === 'everyone' && t - s.broadcastAt < LIMITS.broadcastCooldownMs) {
      throw new HttpError(429, 'broadcast_cooldown', 'You can message everyone nearby once every 2 minutes',
        Math.ceil((s.broadcastAt + LIMITS.broadcastCooldownMs - t) / 1000));
    }

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

    // The same text to lots of different people is spam, however it's split up.
    const key = spamKey(clean);
    const recipients = new Set();
    for (const r of requests.values()) {
      if (r.from === s.id && t - r.createdAt < LIMITS.duplicateWindowMs && spamKey(r.text) === key) recipients.add(r.to);
    }
    const fresh = eligible.filter((o) => !recipients.has(o.id));
    if (recipients.size + fresh.length > LIMITS.maxDuplicateRecipients && fresh.length) {
      throw new HttpError(429, 'duplicate_spam', "You've sent this to a lot of people already. Try again later.", Math.ceil(LIMITS.duplicateWindowMs / 1000));
    }

    s.sends.push(t);
    if (to === 'everyone') s.broadcastAt = t;
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
        replyTo: null,
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
    const sender = fromId && sessions.get(fromId);
    if (sender) {
      const t = now();
      sender.declines = sender.declines.filter((x) => t - x < LIMITS.declineWindowMs);
      sender.declines.push(t);
      if (sender.declines.length >= LIMITS.declinesToMute) {
        sender.mutedUntil = t + LIMITS.muteMs;
        sender.declines = [];
      }
    }
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
    if (target.ipKey) bans.set(target.ipKey, now() + LIMITS.ipSuspensionMs);
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
          isReply: Boolean(r.replyTo),
          canReply: replyBlocker(s, r) === null,
          createdAt: new Date(r.createdAt).toISOString(),
        });
      } else if (r.from === s.id) {
        sent.push({
          id: r.id,
          to: { id: r.to, nickname: r.toNickname, description: r.toDescription },
          status: r.status,
          text: r.text,
          broadcast: r.broadcast,
          isReply: Boolean(r.replyTo),
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
          isReply: false,
          createdAt: new Date(x.createdAt).toISOString(),
        });
      }
    }
    const byNewest = (a, b) => (a.createdAt < b.createdAt ? 1 : -1);
    return { me: publicSelf(s), incoming: incoming.sort(byNewest), sent: sent.sort(byNewest) };
  }

  // Counts only: no ids, nicknames, places or text.
  function stats() {
    const t = now();
    let located = 0, pending = 0, accepted = 0, replies = 0;
    for (const x of sessions.values()) if (hasFreshLocation(x)) located++;
    for (const r of requests.values()) {
      if (r.status === 'pending') pending++;
      else if (r.replyTo) replies++;
      else accepted++;
    }
    const day = 24 * 60 * 60 * 1000;
    const reportsByReason = Object.fromEntries(REPORT_REASONS.map((x) => [x, 0]));
    let reports24h = 0;
    for (const r of reports) {
      if (t - Date.parse(r.at) > day) continue;
      reports24h++;
      reportsByReason[r.reason]++;
    }
    let deviceBans = 0, networkBans = 0;
    for (const [key, until] of bans) {
      if (until <= t) continue;
      if (key.startsWith('push:')) deviceBans++; else networkBans++;
    }
    return {
      sessions: { live: sessions.size, withFreshLocation: located },
      requests: { pending, accepted, replies },
      reports: { last24h: reports24h, byReason: reportsByReason },
      bans: { devices: deviceBans, networks: networkBans },
    };
  }

  return {
    sessions, requests, tombstones, bans, reports, stats,
    createSession, authenticate, touch, updateMe, setLocation, nearby,
    sendRequest, accept, decline: declineWithTombstone, inbox, eraseSession, sweep, publicSelf,
    blockPerson, report, suspend,
  };
}
