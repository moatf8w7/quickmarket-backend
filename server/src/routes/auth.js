import { Router } from 'express';
import { db } from '../db/index.js';
import { asyncRoute, HttpError, publicUser } from '../services/http.js';
import { createToken } from '../services/tokens.js';

const router = Router();

router.post('/session', asyncRoute(async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const rawPhone = typeof req.body?.phone === 'string' ? req.body.phone : '';
  const phone = rawPhone.replace(/[\s().-]/g, '');
  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'يرجى إدخال الاسم بشكل صحيح');
  if (!/^\+?[0-9]{8,16}$/.test(phone)) throw new HttpError(400, 'يرجى إدخال رقم هاتف صحيح');

  const transaction = db.transaction(() => {
    let user = db.prepare('SELECT id, name, phone, email FROM users WHERE phone=?').get(phone);
    if (user) {
      db.prepare('UPDATE users SET name=? WHERE id=?').run(name, user.id);
      user = db.prepare('SELECT id, name, phone, email FROM users WHERE id=?').get(user.id);
    } else {
      const inserted = db.prepare('INSERT INTO users(name, phone) VALUES (?, ?)').run(name, phone);
      user = db.prepare('SELECT id, name, phone, email FROM users WHERE id=?').get(inserted.lastInsertRowid);
    }
    db.prepare('INSERT INTO wallets(user_id, balance_syp, points_balance) VALUES (?, 0, 0) ON CONFLICT(user_id) DO NOTHING').run(user.id);
    return user;
  });
  const user = transaction();
  const token = createToken({ sub: user.id, role: 'customer' }, 60 * 60 * 24 * 30);
  res.status(200).json({ token, user: publicUser(user) });
}));

export default router;


