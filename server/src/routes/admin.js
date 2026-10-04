import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { db, verifyPassword } from '../db/index.js';
import { adminAuth } from '../middleware/auth.js';
import { asyncRoute, categoryDto, HttpError, imageDataUrl, orderCode, parseId, productDto, safeJson, toInteger } from '../services/http.js';
import { processProductImage } from '../services/images.js';
import { changeOrderStatus, readOrder } from '../services/orders.js';
import { getSettings, updateSettings } from '../services/settings.js';
import { createToken } from '../services/tokens.js';

const router = Router();

async function login(req, res) {
  const username = String(req.body?.username || '').trim();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password || username.length > 100 || password.length > 200) throw new HttpError(400, 'أدخل اسم المستخدم وكلمة المرور');
  const admin = db.prepare('SELECT username, password_hash FROM admin_credentials WHERE username=?').get(username);
  if (!admin || !verifyPassword(password, admin.password_hash)) throw new HttpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة', 'unauthorized');
  const token = createToken({ sub: admin.username, role: 'admin' }, 60 * 60 * 12);
  res.json({ token, user: { username: admin.username } });
}

router.post('/session', asyncRoute(login));
router.post('/login', asyncRoute(login));
router.use(adminAuth);

router.get('/dashboard', (_req, res) => {
  const totalProducts = db.prepare('SELECT COUNT(*) AS count FROM products WHERE is_active=1').get().count;
  const activeOffers = db.prepare('SELECT COUNT(*) AS count FROM products WHERE is_active=1 AND discount_percent>0').get().count;
  const recentOrders = db.prepare(`SELECT o.*, EXISTS(SELECT 1 FROM payment_receipts r WHERE r.order_id=o.id) AS has_receipt
    FROM orders o ORDER BY o.id DESC LIMIT 8`).all().map((row) => ({ ...row, code: row.order_number || orderCode(row.id) }));
  const totalOrders = db.prepare('SELECT COUNT(*) AS count FROM orders').get().count;
  res.json({ totalProducts, activeOffers, recentOrders, totalOrders });
});

router.get('/categories', (_req, res) => {
  const rows = db.prepare(`SELECT c.*, COUNT(p.id) AS item_count FROM categories c
    LEFT JOIN products p ON p.category_id=c.id WHERE 1=1 GROUP BY c.id ORDER BY c.sort_order, c.id`).all();
  res.json(rows.map((row) => categoryDto(row, row.item_count)));
});

function imageReference(value, { required = true, label = 'الصورة' } = {}) {
  if (!value && !required) return null;
  if (typeof value !== 'string' || value.length > 12 * 1024 * 1024) throw new HttpError(400, `${label} غير صالحة`);
  if (value.startsWith('data:')) return imageDataUrl(value, { required, label });
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
    return url.toString();
  } catch { throw new HttpError(400, `${label} يجب أن تكون صورة صالحة`); }
}

function slugFor(value) {
  const normalized = String(value).toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  return normalized || `category-${randomBytes(5).toString('hex')}`;
}

router.post('/categories', asyncRoute(async (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (title.length < 2 || title.length > 80) throw new HttpError(400, 'عنوان القسم غير صالح');
  const image = imageReference(req.body?.image ?? req.body?.imageUrl ?? req.body?.image_url);
  const slug = String(req.body?.slug || slugFor(title)).slice(0, 100);
  const sortOrder = toInteger(req.body?.sortOrder ?? req.body?.sort_order ?? 0, 'ترتيب القسم');
  try {
    const result = db.prepare('INSERT INTO categories(slug, title, image_url, sort_order, is_active) VALUES (?, ?, ?, ?, 1)')
      .run(slug, title, image, sortOrder);
    res.status(201).json(categoryDto(db.prepare('SELECT * FROM categories WHERE id=?').get(result.lastInsertRowid), 0));
  } catch (error) {
    if (String(error.code).includes('CONSTRAINT')) throw new HttpError(409, 'اسم القسم مستخدم مسبقاً');
    throw error;
  }
}));

router.put('/categories/:id', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id, 'القسم');
  const existing = db.prepare('SELECT * FROM categories WHERE id=?').get(id);
  if (!existing) throw new HttpError(404, 'القسم غير موجود', 'not_found');
  const title = req.body?.title === undefined ? existing.title : String(req.body.title).trim();
  if (title.length < 2 || title.length > 80) throw new HttpError(400, 'عنوان القسم غير صالح');
  const image = req.body?.image === undefined && req.body?.imageUrl === undefined && req.body?.image_url === undefined
    ? existing.image_url : imageReference(req.body.image ?? req.body.imageUrl ?? req.body.image_url);
  const sortOrder = req.body?.sortOrder === undefined && req.body?.sort_order === undefined
    ? existing.sort_order : toInteger(req.body.sortOrder ?? req.body.sort_order, 'ترتيب القسم');
  db.prepare('UPDATE categories SET title=?, image_url=?, sort_order=? WHERE id=?').run(title, image, sortOrder, id);
  res.json(categoryDto(db.prepare('SELECT * FROM categories WHERE id=?').get(id)));
}));

router.delete('/categories/:id', (req, res) => {
  const id = parseId(req.params.id, 'القسم');
  if (!db.prepare('SELECT id FROM categories WHERE id=?').get(id)) throw new HttpError(404, 'القسم غير موجود', 'not_found');
  db.transaction(() => {
    db.prepare('UPDATE categories SET is_active=0 WHERE id=?').run(id);
    db.prepare('UPDATE products SET is_active=0 WHERE category_id=?').run(id);
  })();
  res.status(204).end();
});

router.get('/products', (_req, res) => {
  const rows = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
  res.json(rows.map((row) => productDto(row)));
});

function productFields(body, existing = {}) {
  const title = body.title === undefined ? existing.title : String(body.title).trim();
  if (typeof title !== 'string' || title.length < 2 || title.length > 120) throw new HttpError(400, 'اسم المنتج غير صالح');
  const categoryId = Number(body.categoryId ?? body.category_id ?? existing.category_id);
  if (!Number.isSafeInteger(categoryId) || categoryId < 1) throw new HttpError(400, 'يرجى اختيار القسم');
  if (!db.prepare('SELECT id FROM categories WHERE id=? AND is_active=1').get(categoryId)) throw new HttpError(400, 'القسم المحدد غير موجود');
  const price = body.price === undefined ? existing.price : toInteger(body.price, 'السعر', { min: 1, max: 2_000_000_000 });
  const discount = body.discountPercent ?? body.discount_percent;
  const discountPercent = discount === undefined ? Number(existing.discount_percent || 0) : Number(discount);
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) throw new HttpError(400, 'نسبة الخصم يجب أن تكون بين ٠ و١٠٠');
  const weightVolume = body.weightVolume ?? body.weight_volume;
  const imageInput = body.image ?? body.imageUrl ?? body.image_url;
  let image = existing.image_url;
  let enhanced = existing.enhanced_image_url;
  let imageProcessing = existing.enhanced_image_url ? 'mock-enhanced' : 'not-processed';
  if (imageInput !== undefined) {
    if (typeof imageInput === 'string' && imageInput.startsWith('data:')) {
      const processed = processProductImage(imageInput);
      image = processed.original;
      enhanced = processed.enhanced;
      imageProcessing = processed.processing;
    } else {
      image = imageReference(imageInput, { label: 'صورة المنتج' });
      enhanced = image;
      imageProcessing = 'mock-enhanced';
    }
  }
  if (!image) throw new HttpError(400, 'صورة المنتج مطلوبة');
  const quantity = body.quantity === undefined ? Number(existing.quantity ?? 99) : toInteger(body.quantity, 'الكمية', { max: 1_000_000 });
  return {
    title, categoryId, price,
    description: body.description === undefined ? String(existing.description || '') : String(body.description).slice(0, 1000),
    discountPercent, weightVolume: weightVolume === undefined ? String(existing.weight_volume || '') : String(weightVolume).trim().slice(0, 60),
    image, enhanced, quantity, imageProcessing,
  };
}

router.post('/products', asyncRoute(async (req, res) => {
  const fields = productFields(req.body || {});
  const result = db.prepare(`INSERT INTO products(category_id, title, description, price, discount_percent, weight_volume,
    image_url, enhanced_image_url, quantity, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(fields.categoryId, fields.title, fields.description, fields.price, fields.discountPercent, fields.weightVolume,
      fields.image, fields.enhanced, fields.quantity);
  const product = productDto(db.prepare('SELECT * FROM products WHERE id=?').get(result.lastInsertRowid));
  res.status(201).json({ ...product, imageProcessing: fields.imageProcessing });
}));

router.put('/products/:id', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id, 'المنتج');
  const existing = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!existing) throw new HttpError(404, 'المنتج غير موجود', 'not_found');
  const fields = productFields(req.body || {}, existing);
  db.prepare(`UPDATE products SET category_id=?, title=?, description=?, price=?, discount_percent=?, weight_volume=?,
    image_url=?, enhanced_image_url=?, quantity=? WHERE id=?`)
    .run(fields.categoryId, fields.title, fields.description, fields.price, fields.discountPercent,
      fields.weightVolume, fields.image, fields.enhanced, fields.quantity, id);
  res.json({ ...productDto(db.prepare('SELECT * FROM products WHERE id=?').get(id)), imageProcessing: fields.imageProcessing });
}));

router.delete('/products/:id', (req, res) => {
  const id = parseId(req.params.id, 'المنتج');
  const result = db.prepare('UPDATE products SET is_active=0 WHERE id=?').run(id);
  if (!result.changes) throw new HttpError(404, 'المنتج غير موجود', 'not_found');
  res.status(204).end();
});

router.get('/settings', (_req, res) => res.json(getSettings()));

const patchSettingsHandler = asyncRoute(async (req, res) => {
  const patch = req.body || {};
  if (patch.chamCash) {
    const walletNumber = String(patch.chamCash.walletNumber ?? patch.chamCash.wallet_number ?? '').trim();
    const ownerName = String(patch.chamCash.ownerName ?? patch.chamCash.owner_name ?? '').trim();
    const qr = patch.chamCash.qrCodeImage ?? patch.chamCash.qr_code_image ?? '';
    if (!walletNumber || walletNumber.length > 80 || ownerName.length < 2 || ownerName.length > 100) throw new HttpError(400, 'تحقق من اسم صاحب المحفظة ورقمها');
    imageReference(qr, { required: false, label: 'رمز QR' });
    patch.chamCash = { ownerName, walletNumber, qrCodeImage: qr };
  }
  if (patch.loyalty) {
    const earnRate = Number(patch.loyalty.pointsPer100Syp ?? patch.loyalty.points_per_100_syp);
    const value = Number(patch.loyalty.sypPerPoint ?? patch.loyalty.syp_per_point);
    const maximum = Number(patch.loyalty.maxPointsPerOrder ?? patch.loyalty.max_points_per_order);
    if (!Number.isFinite(earnRate) || earnRate <= 0 || !Number.isSafeInteger(value) || value <= 0 || !Number.isFinite(maximum) || maximum <= 0 || maximum > 200) {
      throw new HttpError(400, 'إعدادات النقاط غير صالحة');
    }
    patch.loyalty = { pointsPer100Syp: earnRate, sypPerPoint: value, maxPointsPerOrder: maximum };
  }
  if (patch.deliveryFee !== undefined) patch.deliveryFee = toInteger(patch.deliveryFee, 'رسوم التوصيل');
  if (patch.storeName !== undefined && (String(patch.storeName).trim().length < 2 || String(patch.storeName).trim().length > 100)) throw new HttpError(400, 'اسم المتجر غير صالح');
  if (patch.currency !== undefined && String(patch.currency).trim().length > 12) throw new HttpError(400, 'رمز العملة غير صالح');
  try { res.json(updateSettings(patch)); } catch (error) {
    if (error.message.startsWith('Unsupported setting:')) throw new HttpError(400, 'إعداد غير معروف');
    throw error;
  }
});
router.put('/settings', patchSettingsHandler);
router.patch('/settings', patchSettingsHandler);

router.get('/orders', (_req, res) => {
  const rows = db.prepare(`SELECT o.*, EXISTS(SELECT 1 FROM payment_receipts r WHERE r.order_id=o.id) AS has_receipt
    FROM orders o ORDER BY o.id DESC LIMIT 200`).all();
  res.json(rows.map((row) => ({ ...readOrder(row.id), hasReceipt: Boolean(row.has_receipt) })));
});

router.get('/orders/:id/receipt', (req, res) => {
  const id = parseId(req.params.id, 'الطلب');
  const order = db.prepare('SELECT id FROM orders WHERE id=?').get(id);
  if (!order) throw new HttpError(404, 'الطلب غير موجود', 'not_found');
  const receipt = db.prepare(`SELECT id, file_path AS receiptDataUrl, original_name AS originalName, mime_type AS mimeType,
    file_size AS fileSize, operation_number AS transactionNo, status, uploaded_at AS uploadedAt
    FROM payment_receipts WHERE order_id=? ORDER BY id DESC LIMIT 1`).get(id);
  if (!receipt) throw new HttpError(404, 'لا توجد صورة إشعار لهذا الطلب', 'not_found');
  res.json(receipt);
});

router.get('/orders/:id', (req, res) => {
  const order = readOrder(parseId(req.params.id, 'الطلب'), { includeReceipt: true });
  if (!order) throw new HttpError(404, 'الطلب غير موجود', 'not_found');
  res.json(order);
});

router.patch('/orders/:id/status', asyncRoute(async (req, res) => {
  const status = String(req.body?.status || '').toLowerCase();
  const allowed = new Set(['pending', 'confirmed', 'preparing', 'dispatched', 'delivered', 'cancelled']);
  if (!allowed.has(status)) throw new HttpError(400, 'حالة الطلب غير صالحة');
  const order = changeOrderStatus(parseId(req.params.id, 'الطلب'), status);
  if (!order) throw new HttpError(404, 'الطلب غير موجود', 'not_found');
  res.json(order);
}));

router.post('/orders/:id/dispatch', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id, 'الطلب');
  const dispatch = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    if (!order) throw new HttpError(404, 'الطلب غير موجود', 'not_found');
    if (order.status === 'cancelled' || order.status === 'delivered') throw new HttpError(409, 'لا يمكن إرسال هذا الطلب للتوصيل');
    let manifest = db.prepare('SELECT * FROM shipment_manifests WHERE order_id=?').get(id);
    if (!manifest) {
      const code = `MS-DLV-${id}-${Date.now().toString(36).toUpperCase()}`;
      const items = db.prepare('SELECT title, quantity, weight_volume, line_total_syp FROM order_items WHERE order_id=?').all(id);
      const payload = { orderCode: order.order_number || orderCode(id), customerName: order.customer_name,
        phone: order.phone, address: safeJson(order.address_snapshot, order.address_snapshot), items,
        codAmountSyp: order.payment_method === 'cod' ? order.total_syp : 0, notes: order.notes || '' };
      db.prepare(`INSERT INTO shipment_manifests(order_id, provider, manifest_number, status, payload_json)
        VALUES (?, 'local_delivery', ?, 'dispatched', ?)`)
        .run(id, code, JSON.stringify(payload));
      manifest = db.prepare('SELECT * FROM shipment_manifests WHERE order_id=?').get(id);
    }
    db.prepare("UPDATE orders SET status='dispatched' WHERE id=? AND status NOT IN ('delivered','cancelled')").run(id);
    return { ...readOrder(id), manifest: { ...manifest, payload: safeJson(manifest.payload_json, {}) } };
  });
  res.json(dispatch());
}));

export default router;

