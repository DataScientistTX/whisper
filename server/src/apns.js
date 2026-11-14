// Minimal Apple Push Notification service client: HTTP/2 + token (JWT ES256) auth.
// No dependencies. If APNS_* variables are missing, pushes are logged and skipped
// so the server still runs locally and in tests.

import http2 from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function createApns(env = process.env, log = console) {
  const keyPem = (env.APNS_KEY || '').replace(/\\n/g, '\n').trim();
  const keyId = env.APNS_KEY_ID;
  const teamId = env.APNS_TEAM_ID;
  const topic = env.APNS_BUNDLE_ID;
  const host = (env.APNS_ENV || 'sandbox') === 'production'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';

  const configured = Boolean(keyPem && keyId && teamId && topic);
  if (!configured) {
    log.warn?.('[apns] APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID / APNS_BUNDLE_ID not set: pushes are disabled');
  }

  let key = null;
  let jwt = null;
  let jwtAt = 0;
  let session = null;

  function token() {
    const now = Math.floor(Date.now() / 1000);
    if (jwt && now - jwtAt < 50 * 60) return jwt; // Apple: refresh between 20 and 60 min
    key ??= createPrivateKey(keyPem);
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
    const claims = b64url(JSON.stringify({ iss: teamId, iat: now }));
    const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
    jwt = `${header}.${claims}.${b64url(sig)}`;
    jwtAt = now;
    return jwt;
  }

  function client() {
    if (session && !session.closed && !session.destroyed) return session;
    session = http2.connect(host);
    session.on('error', (e) => log.error?.('[apns] connection error', e.message));
    session.on('goaway', () => session?.close());
    session.unref?.();
    return session;
  }

  // Resolves to { ok, status, reason }. Never throws.
  function send(deviceToken, payload, { expiresInSec = 600, collapseId } = {}) {
    if (!configured || !deviceToken) return Promise.resolve({ ok: false, status: 0, reason: 'disabled' });
    return new Promise((resolve) => {
      let req;
      try {
        const headers = {
          ':method': 'POST',
          ':path': `/3/device/${deviceToken}`,
          authorization: `bearer ${token()}`,
          'apns-topic': topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(Date.now() / 1000) + expiresInSec),
        };
        if (collapseId) headers['apns-collapse-id'] = collapseId;
        req = client().request(headers);
      } catch (e) {
        resolve({ ok: false, status: 0, reason: e.message });
        return;
      }
      let status = 0;
      let body = '';
      req.setEncoding('utf8');
      req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let reason;
        try { reason = body ? JSON.parse(body).reason : undefined; } catch { reason = body; }
        if (status !== 200) log.warn?.(`[apns] push failed: ${status} ${reason ?? ''}`);
        resolve({ ok: status === 200, status, reason });
      });
      req.on('error', (e) => resolve({ ok: false, status: 0, reason: e.message }));
      req.end(JSON.stringify(payload));
    });
  }

  return { configured, send, close: () => session?.close() };
}
