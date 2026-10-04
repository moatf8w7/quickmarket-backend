import { Router } from 'express';
import { db } from '../db/index.js';
import { customerAuth } from '../middleware/auth.js';
import { asyncRoute, HttpError, parseId, publicUser } from '../services/http.js';
import { orderCode } from '../services/http.js';
import { getSettings } from '../services/settings.js';

const router = Router();
router.use(customerAuth);

function walletFor(userId) {
  db.prepare('INSERT INTO wallets(user_id, balance_syp, points_balance) VALUES (?, 0, 0) ON CONFLICT(user_id) DO NOTHING').run(userId);
  const wallet = db.prepare('SELECT balance_syp, points_balance FROM wallets WHERE user_id=?').get(userId);
  return { ...wallet, balanceSyp: wallet.balance_syp, pointsBalance: wallet.points_balance };
}

function addressInput(body = {}) {
  const recipientName = String(body.recipientName ?? body.recipient_name ?? '').trim();
  const phone = String(body.phone ?? '').trim();
  const city = String(body.city ?? '').trim();
  const area = String(body.area ?? '').trim();
  const street = String(body.street ?? '').trim();
  const building = String(body.building ?? '').trim();
  if (recipientName.length < 2 || !/^\+?[0-9\s()-]{8,20}$/.test(phone) || !city || !area || !street) {
    throw new HttpError(400, 'يرجى إكمال الاسم ورقم الهاتف والمدينة والمنطقة والشارع');
  }
  return {
    label: String(body.label || 'المنزل').trim().slice(0, 40), recipient_name: recipientName,
    phone: phone.replace(/[\s()-]/g, ''), city, area, street, building,
    notes: String(body.notes || '').trim().slice(0, 500), is_default: body.isDefault || body.is_default ? 1 : 0,
  };
}

router.get('/', (req, res) => {
  const addresses = db.prepare('SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC, id DESC').all(req.auth.user.id);
  res.json({ user: publicUser(req.auth.user), wallet: walletFor(req.auth.user.id), addresses });
});

router.put('/', asyncRoute(async (req, res) => {
  const fields = [];
  const values = [];
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (name.length < 2 || name.length > 80) throw new HttpError(400, 'يرجى إدخال الاسم بشكل صحيح');
    fields.push('name=?'); values.push(name);
  }
  if (req.body?.email !== undefined) {
    const email = String(req.body.email).trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'البريد الإلكتروني غير صالح');
    fields.push('email=?'); values.push(email || null);
  }
  if (!fields.length) throw new HttpError(400, 'لا توجد بيانات لتحديثها');
  values.push(req.auth.user.id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id=?`).run(...values);
  res.json({ user: publicUser(db.prepare('SELECT id, name, phone, email FROM users WHERE id=?').get(req.auth.user.id)) });
}));

router.get('/orders', (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.auth.user.id);
  res.json(orders.map((order) => ({ ...order, code: order.order_number || orderCode(order.id), total: order.total_syp })));
});

router.post('/addresses', asyncRoute(async (req, res) => {
  const address = addressInput(req.body);
  const tx = db.transaction(() => {
    if (address.is_default) db.prepare('UPDATE addresses SET is_default=0 WHERE user_id=?').run(req.auth.user.id);
    const result = db.prepare(`INSERT INTO addresses(user_id, label, recipient_name, phone, city, area, street,
      building, notes, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.auth.user.id, address.label, address.recipient_name, address.phone, address.city, address.area,
        address.street, address.building, address.notes, address.is_default);
    return db.prepare('SELECT * FROM addresses WHERE id=?').get(result.lastInsertRowid);
  });
  res.status(201).json(tx());
}));

router.put('/addresses/:id', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id, 'العنوان');
  const exists = db.prepare('SELECT id FROM addresses WHERE id=? AND user_id=?').get(id, req.auth.user.id);
  if (!exists) throw new HttpError(404, 'العنوان غير موجود', 'not_found');
  const address = addressInput(req.body);
  const tx = db.transaction(() => {
    if (address.is_default) db.prepare('UPDATE addresses SET is_default=0 WHERE user_id=?').run(req.auth.user.id);
    db.prepare(`UPDATE addresses SET label=?, recipient_name=?, phone=?, city=?, area=?, street=?, building=?, notes=?, is_default=?
      WHERE id=? AND user_id=?`).run(address.label, address.recipient_name, address.phone, address.city, address.area,
      address.street, address.building, address.notes, address.is_default, id, req.auth.user.id);
    return db.prepare('SELECT * FROM addresses WHERE id=?').get(id);
  });
  res.json(tx());
}));

router.delete('/addresses/:id', (req, res) => {
  const result = db.prepare('DELETE FROM addresses WHERE id=? AND user_id=?').run(parseId(req.params.id, 'العنوان'), req.auth.user.id);
  if (!result.changes) throw new HttpError(404, 'العنوان غير موجود', 'not_found');
  res.status(204).end();
});

export const convertWalletHandler = asyncRoute(async (req, res) => {
  const wallet = walletFor(req.auth.user.id);
  const requested = req.body?.points === undefined ? Number(wallet.points_balance) : Number(req.body.points);
  const available = Math.floor(Number(wallet.points_balance) * 10) / 10;
  const points = Math.round(requested * 10) / 10;
  if (!Number.isFinite(points) || points <= 0 || points > available) throw new HttpError(400, 'رصيد النقاط غير كافٍ أو القيمة غير صالحة');
  const cash = Math.round(points * Number(getSettings().loyalty.sypPerPoint));
  const converted = db.transaction(() => {
    const current = db.prepare('SELECT id, balance_syp, points_balance FROM wallets WHERE user_id=?').get(req.auth.user.id);
    if (Number(current.points_balance) + 1e-9 < points) throw new HttpError(409, 'تغيّر رصيد النقاط، حاول مجدداً');
    const nextPoints = Math.round((Number(current.points_balance) - points) * 10) / 10;
    const nextCash = Number(current.balance_syp) + cash;
    db.prepare('UPDATE wallets SET balance_syp=?, points_balance=? WHERE user_id=?').run(nextCash, nextPoints, req.auth.user.id);
    db.prepare(`INSERT INTO loyalty_transactions(wallet_id, type, points_delta, balance_points, cash_delta_syp, balance_syp, description)
      VALUES (?, 'conversion', ?, ?, ?, ?, ?)`)
      .run(current.id, -points, nextPoints, cash, nextCash, 'تحويل النقاط إلى رصيد نقدي');
    return { balanceSyp: nextCash, pointsBalance: nextPoints };
  });
  res.json({ convertedPoints: points, addedSyp: cash, wallet: converted() });
});
router.post('/wallet/convert', convertWalletHandler);

export default router;

