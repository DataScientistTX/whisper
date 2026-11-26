// Small HTTP helpers: bounded JSON bodies and JSON answers.

import { HttpError } from './errors.js';
import { LIMITS } from './state.js';

const MAX_BODY_BYTES = LIMITS.maxBodyBytes;

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new HttpError(413, 'body_too_large')); req.destroy(); return; }
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

export function send(res, status, body) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

// The client's IP. Behind a proxy (Railway has one) the real address is the one
// the proxy appended to X-Forwarded-For; anything before it came from the
// client and can be made up, so trusting the first entry would let anyone dodge
// the per-IP limits and bans. trustedHops is how many proxies sit in front.
export function clientIp(req, trustedHops = 1) {
  const socketIp = req.socket?.remoteAddress ?? '';
  if (!trustedHops) return socketIp;
  const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!chain.length) return socketIp;
  return chain[Math.max(chain.length - trustedHops, 0)];
}
