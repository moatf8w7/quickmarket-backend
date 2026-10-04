import { db } from '../db/index.js';
import { HttpError } from '../services/http.js';
import { verifyToken } from '../services/tokens.js';

function bearer(req) {
  const authorization = req.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) throw new HttpError(401, 'يلزم تسجيل الدخول', 'unauthorized');
  return authorization.slice(7).trim();
}

export function customerAuth(req, _res, next) {
  try {
    const claims = verifyToken(bearer(req));
    if (claims.role !== 'customer') throw new HttpError(403, 'هذه العملية متاحة للعملاء فقط', 'forbidden');
    const user = db.prepare('SELECT id, name, phone, email FROM users WHERE id = ?').get(Number(claims.sub));
    if (!user) throw new HttpError(401, 'حساب المستخدم غير موجود', 'unauthorized');
    req.auth = { role: 'customer', user };
    next();
  } catch (error) { next(error); }
}

export function adminAuth(req, _res, next) {
  try {
    const claims = verifyToken(bearer(req));
    if (claims.role !== 'admin') throw new HttpError(403, 'هذه العملية متاحة للإدارة فقط', 'forbidden');
    req.auth = { role: 'admin', username: claims.sub };
    next();
  } catch (error) { next(error); }
}


