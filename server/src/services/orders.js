import { db, getSetting } from '../db/index.js';
import { orderCode, safeJson } from './http.js';
import { HttpError } from './http.js';

export function readOrder(orderId, { includeReceipt = false } = {}) {
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!row) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(orderId).map((item) => ({
    ...item, productId: item.product_id, unitPrice: item.unit_price_syp,
    weightVolume: item.weight_volume, lineTotal: item.line_total_syp,
  }));
  const manifest = db.prepare('SELECT * FROM shipment_manifests WHERE order_id=? ORDER BY rowid DESC LIMIT 1').get(orderId);
  const order = {
    ...row,
    code: row.order_number || orderCode(row.id),
    subtotal: row.subtotal_syp,
    discount: row.discount_syp,
    walletRedeemed: row.wallet_redeemed_syp,
    deliveryFee: row.delivery_fee_syp,
    total: row.total_syp,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    address: safeJson(row.address_snapshot, row.address_snapshot),
    items,
    manifest: manifest ? { ...manifest, payload: safeJson(manifest.payload_json, null) } : null,
  };
  if (includeReceipt) order.receipt = db.prepare('SELECT file_path AS receiptDataUrl, operation_number AS transactionNo, uploaded_at AS uploadedAt FROM payment_receipts WHERE order_id=? ORDER BY id DESC LIMIT 1').get(orderId) || null;
  return order;
}

export function awardDeliveryPoints(order) {
  if (order.status !== 'delivered' || !order.user_id) return false;
  const alreadyAwarded = db.prepare("SELECT 1 FROM loyalty_transactions WHERE order_id=? AND type='order_reward' LIMIT 1").get(order.id);
  if (alreadyAwarded) return false;
  const eligibleSpend = Math.max(0, Number(order.subtotal_syp) - Number(order.discount_syp));
  const points = Math.floor(eligibleSpend / 100) * Number(getSetting('loyalty.points_per_100_syp', 0.1));
  if (points <= 0) return false;
  db.prepare('INSERT INTO wallets(user_id, balance_syp, points_balance) VALUES (?, 0, 0) ON CONFLICT(user_id) DO NOTHING').run(order.user_id);
  const wallet = db.prepare('SELECT balance_syp, points_balance FROM wallets WHERE user_id=?').get(order.user_id);
  const updatedPoints = Number(wallet.points_balance) + points;
  db.prepare('UPDATE wallets SET points_balance=? WHERE user_id=?').run(updatedPoints, order.user_id);
  db.prepare('UPDATE orders SET points_earned=?, delivered_at=COALESCE(delivered_at, datetime(\'now\')) WHERE id=?').run(points, order.id);
  db.prepare(`INSERT INTO loyalty_transactions(wallet_id, order_id, type, points_delta, balance_points,
      cash_delta_syp, balance_syp, description)
    SELECT id, ?, 'order_reward', ?, ?, 0, balance_syp, ? FROM wallets WHERE user_id=?`)
    .run(order.id, points, updatedPoints, `نقاط مقابل الطلب ${orderCode(order.id)}`, order.user_id);
  return true;
}

export function changeOrderStatus(orderId, status) {
  return db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!order) return null;
    if (order.status === 'cancelled' && status !== 'cancelled') {
      throw new HttpError(409, 'لا يمكن إعادة تفعيل طلب ملغي');
    }
    if (order.status === 'delivered' && status !== 'delivered') {
      throw new HttpError(409, 'الطلب الذي تم تسليمه نهائي');
    }
    db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, orderId);
    const updated = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (status === 'delivered') awardDeliveryPoints(updated);
    return readOrder(orderId);
  })();
}

