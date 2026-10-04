import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.js';

const secret = process.env.SESSION_SECRET || 'market-sama-local-development-secret-change-me';
if (process.env.NODE_ENV === 'production' &&
    (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 || process.env.SESSION_SECRET === 'change-this-before-deploying')) {
  throw new Error('Set a unique SESSION_SECRET of at least 32 characters in production');
}

function sign(encodedPayload) {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

export function createToken({ sub, role }, lifetimeSeconds) {
  const payload = Buffer.from(JSON.stringify({
    sub: String(sub), role, exp: Math.floor(Date.now() / 1000) + lifetimeSeconds,
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string') throw new HttpError(401, 'يلزم تسجيل الدخول', 'unauthorized');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw new HttpError(401, 'جلسة الدخول غير صالحة', 'unauthorized');
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new HttpError(401, 'جلسة الدخول غير صالحة', 'unauthorized');
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch {
    throw new HttpError(401, 'جلسة الدخول غير صالحة', 'unauthorized');
  }
  if (!claims.sub || !claims.role || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) {
    throw new HttpError(401, 'انتهت صلاحية الجلسة', 'unauthorized');
  }
  return claims;
}
