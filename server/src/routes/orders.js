import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { db } from '../db/index.js';
import { customerAuth } from '../middleware/auth.js';
import { asyncRoute, HttpError, imageDataUrl, orderCode, parseId } from '../services/http.js';
import { readOrder } from '../services/orders.js';
import { getSettings } from '../services/settings.js';

const router = Router();
router.use(customerAuth);

function resolveAddress(input, userId) {
  if (input?.addressId || input?.address_id) {
    const row = db.prepare('SELECT * FROM addresses WHERE id=? AND user_id=?').get(Number(input.addressId ?? input.address_id), userId);
    if (!row) throw new HttpError(400, 'عنوان التوصيل غير موجود');
    return row;
  }
  const address = input?.address;
  if (typeof address === 'string' && address.trim()) return { label: 'عنوان التوصيل', street: address.trim() };
  if (!address || typeof address !== 'object') throw new HttpError(400, 'يرجى تحديد عنوان التوصيل');
  const city = String(address.city || '').trim();
  const area = String(address.area || '').trim();
  const street = String(address.street || address.addressLine || '').trim();
  if (!city || !area || !street) throw new HttpError(400, 'يرجى إكمال المدينة والمنطقة والشارع');
  return {
    label: String(address.label || 'عنوان التوصيل'), recipient_name: String(address.recipientName || address.recipient_name || ''),
    phone: String(address.phone || ''), city, area, street, building: String(address.building || ''), notes: String(address.notes || ''),
  };
}

function amount(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, `${label} غير صالح`);
  return n;
}

router.post('/', asyncRoute(async (req, res) => {
  const inputItems = req.body?.items;
  if (!Array.isArray(inputItems) || inputItems.length < 1 || inputItems.length > 100) {
    throw new HttpError(400, 'أضف منتجاً واحداً على الأقل إلى السلة');
  }
  const paymentRaw = String(req.body.paymentMethod ?? req.body.payment_method ?? 'cod').toLowerCase();
  const paymentMethod = ['chamcash', 'cham_cash', 'شام كاش'].includes(paymentRaw) ? 'cham_cash' :
    ['cod', 'cash_on_delivery', 'cash', 'الدفع عند الاستلام'].includes(paymentRaw) ? 'cod' : null;
  if (!paymentMethod) throw new HttpError(400, 'طريقة الدفع غير مدعومة');
  const settings = getSettings();
  if (paymentMethod === 'cod' && !settings.codEnabled) throw new HttpError(400, 'الدفع عند الاستلام غير متاح حالياً');
  if (paymentMethod === 'cham_cash' && !settings.chamCashEnabled) throw new HttpError(400, 'شام كاش غير متاح حالياً');
  const address = resolveAddress(req.body, req.auth.user.id);
  const customerName = String(req.body.customerName || req.body.customer_name || address.recipient_name || req.auth.user.name).trim();
  const phone = String(req.body.phone || address.phone || req.auth.user.phone).trim();
  if (!customerName || !phone) throw new HttpError(400, 'يرجى تحديد الاسم ورقم الهاتف للتوصيل');
  const pointsRequested = Number(req.body.pointsToRedeem ?? req.body.points_to_redeem ?? 0);
  const pointsPerSyp = Number(settings.loyalty.sypPerPoint) || 10;
  const maxPoints = Math.min(200, Number(settings.loyalty.maxPointsPerOrder) || 200);
  if (!Number.isFinite(pointsRequested) || pointsRequested < 0 || pointsRequested > maxPoints || Math.round(pointsRequested * 10) !== pointsRequested * 10) {
    throw new HttpError(400, `يمكن استخدام حتى ${maxPoints} نقطة في الطلب الواحد`);
  }
  const walletRequested = amount(req.body.walletAmount ?? req.body.walletUseSyp ?? req.body.wallet_amount ?? 0, 'مبلغ المحفظة');
  const deliveryFee = amount(settings.deliveryFee || 0, 'رسوم التوصيل');
  const addressSnapshot = JSON.stringify(address);
  const note = String(req.body.notes || '').trim().slice(0, 1000);

  const create = db.transaction(() => {
    db.prepare('INSERT INTO wallets(user_id, balance_syp, points_balance) VALUES (?, 0, 0) ON CONFLICT(user_id) DO NOTHING').run(req.auth.user.id);
    const wallet = db.prepare('SELECT id, balance_syp, points_balance FROM wallets WHERE user_id=?').get(req.auth.user.id);
    if (pointsRequested > Number(wallet.points_balance)) throw new HttpError(400, 'رصيد النقاط غير كافٍ');

    const lines = [];
    let subtotal = 0;
    let discount = 0;
    for (const entry of inputItems) {
      const productId = Number(entry.productId ?? entry.product_id ?? entry.id);
      const quantity = Number(entry.quantity ?? entry.qty ?? 1);
      if (!Number.isSafeInteger(productId) || productId < 1 || !Number.isFinite(quantity) || quantity <= 0 || quantity > 99) {
        throw new HttpError(400, 'تفاصيل أحد المنتجات غير صالحة');
      }
      const product = db.prepare('SELECT * FROM products WHERE id=? AND is_active=1').get(productId);
      if (!product) throw new HttpError(400, 'أحد المنتجات لم يعد متاحاً');
      if (product.quantity < quantity) throw new HttpError(409, `الكمية المتاحة من ${product.title} هي ${product.quantity}`);
      const unitPrice = Math.max(0, Math.round(product.price * (100 - product.discount_percent) / 100));
      const lineTotal = Math.round(unitPrice * quantity);
      const lineDiscount = Math.round(product.price * quantity) - lineTotal;
      subtotal += Math.round(product.price * quantity);
      discount += lineDiscount;
      lines.push({ product, quantity, unitPrice, lineTotal, lineDiscount });
    }
    const balanceAfterOffer = Math.max(0, subtotal - discount);
    const pointsCanUse = Math.floor((balanceAfterOffer / pointsPerSyp) * 10) / 10;
    const pointsUsed = Math.min(pointsRequested, pointsCanUse);
    const pointsApplied = Math.round(pointsUsed * pointsPerSyp);
    const dueBeforeWallet = Math.max(0, balanceAfterOffer - pointsApplied + deliveryFee);
    const walletUsed = Math.min(walletRequested, dueBeforeWallet, Number(wallet.balance_syp));
    const total = dueBeforeWallet - walletUsed;
    const result = db.prepare(`INSERT INTO orders(user_id, customer_name, phone, address_snapshot, subtotal_syp,
      discount_syp, wallet_redeemed_syp, delivery_fee_syp, total_syp, points_earned, points_redeemed,
      status, payment_method, payment_status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?, 'pending', ?)`)
      .run(req.auth.user.id, customerName, phone, addressSnapshot, subtotal, discount + pointsApplied,
        walletUsed, deliveryFee, total, pointsUsed, paymentMethod, note);
    const id = Number(result.lastInsertRowid);
    const code = `MS-${randomBytes(6).toString('hex').toUpperCase()}`;
    db.prepare('UPDATE orders SET order_number=? WHERE id=?').run(code, id);
    const addItem = db.prepare(`INSERT INTO order_items(order_id, product_id, title, unit_price_syp, quantity, weight_volume, line_total_syp)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const decreaseStock = db.prepare('UPDATE products SET quantity=quantity-? WHERE id=? AND quantity>=?');
    for (const line of lines) {
      addItem.run(id, line.product.id, line.product.title, line.unitPrice, line.quantity, line.product.weight_volume, line.lineTotal);
      const updated = decreaseStock.run(line.quantity, line.product.id, line.quantity);
      if (!updated.changes) throw new HttpError(409, 'تغيّرت كمية أحد المنتجات، حدّث السلة وحاول مجدداً');
    }
    if (walletUsed > 0) {
      const balanceSyp = Number(wallet.balance_syp) - walletUsed;
      db.prepare('UPDATE wallets SET balance_syp=? WHERE user_id=?').run(balanceSyp, req.auth.user.id);
      db.prepare(`INSERT INTO loyalty_transactions(wallet_id, order_id, type, points_delta, balance_points,
        cash_delta_syp, balance_syp, description) VALUES (?, ?, 'wallet_order', 0, ?, ?, ?, ?)`)
        .run(wallet.id, id, wallet.points_balance, -walletUsed, balanceSyp, `استخدام رصيد للطلب ${code}`);
    }
    if (pointsUsed > 0) {
      const balancePoints = Math.round((Number(wallet.points_balance) - pointsUsed) * 10) / 10;
      db.prepare('UPDATE wallets SET points_balance=? WHERE user_id=?').run(balancePoints, req.auth.user.id);
      db.prepare(`INSERT INTO loyalty_transactions(wallet_id, order_id, type, points_delta, balance_points,
        cash_delta_syp, balance_syp, description) VALUES (?, ?, 'order_redeem', ?, ?, 0, ?, ?)`)
        .run(wallet.id, id, -pointsUsed, balancePoints, Number(wallet.balance_syp) - walletUsed, `استخدام نقاط للطلب ${code}`);
    }
    return id;
  });

  const id = create();
  res.status(201).json(readOrder(id));
}));

router.post('/:id/receipt', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id, 'الطلب');
  const order = db.prepare('SELECT id, user_id, payment_method, status FROM orders WHERE id=?').get(id);
  if (!order || order.user_id !== req.auth.user.id) throw new HttpError(404, 'الطلب غير موجود', 'not_found');
  if (order.payment_method !== 'cham_cash') throw new HttpError(400, 'رفع الإشعار متاح لطلبات شام كاش فقط');
  if (['cancelled', 'delivered'].includes(order.status)) throw new HttpError(409, 'لا يمكن إرفاق إشعار بهذا الطلب');
  const receipt = imageDataUrl(req.body?.receiptDataUrl, { required: true, label: 'صورة الإشعار' });
  const operationNumber = String(req.body?.transactionNo || req.body?.operationNumber || '').trim().slice(0, 100) || null;
  const match = receipt.match(/^data:image\/([^;]+);base64,(.*)$/i);
  const mimeType = `image/${match[1].toLowerCase().replace('jpg', 'jpeg')}`;
  const fileSize = Math.floor(Buffer.from(match[2], 'base64').length);
  db.prepare('INSERT INTO payment_receipts(order_id, file_path, original_name, mime_type, file_size, operation_number, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, receipt, `receipt-${id}`, mimeType, fileSize, operationNumber, 'pending');
  res.status(201).json({ order: readOrder(id), receiptAttached: true });
}));

export const trackRouter = Router();
trackRouter.get('/:code', (req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const row = db.prepare('SELECT * FROM orders WHERE order_number=?').get(code);
  if (!row) throw new HttpError(404, 'لم يتم العثور على الطلب', 'not_found');
  res.json({ code: row.order_number || orderCode(row.id), status: row.status, paymentMethod: row.payment_method,
    paymentStatus: row.payment_status, total: row.total_syp, createdAt: row.created_at,
    items: db.prepare('SELECT title, quantity, weight_volume FROM order_items WHERE order_id=? ORDER BY id').all(row.id) });
});

export default router;

