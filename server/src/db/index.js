import Database from 'better-sqlite3';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const configuredPath = process.env.SQLITE_DB_PATH;
const databasePath = configuredPath
  ? (configuredPath === ':memory:' ? configuredPath : path.resolve(configuredPath))
  : path.resolve(currentDirectory, '../../data/market-sama.sqlite');

if (databasePath !== ':memory:') {
  mkdirSync(path.dirname(databasePath), { recursive: true });
}

export const db = new Database(databasePath);
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
if (databasePath !== ':memory:') db.pragma('journal_mode = WAL');

const SCRYPT_KEY_LENGTH = 64;

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('Password must be a non-empty string');
  }

  const salt = randomBytes(16).toString('hex');
  const derivedKey = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

export function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string') return false;

  const [algorithm, salt, expectedHex] = storedHash.split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex || expectedHex.length !== SCRYPT_KEY_LENGTH * 2) {
    return false;
  }

  try {
    const actual = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
    const expected = Buffer.from(expectedHex, 'hex');
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT 'المنزل',
    recipient_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    city TEXT NOT NULL DEFAULT 'دمشق',
    area TEXT NOT NULL,
    street TEXT,
    building TEXT,
    notes TEXT,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    image_url TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL CHECK (price >= 0),
    discount_percent REAL NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
    weight_volume TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL,
    enhanced_image_url TEXT,
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address_snapshot TEXT NOT NULL,
    subtotal_syp INTEGER NOT NULL CHECK (subtotal_syp >= 0),
    discount_syp INTEGER NOT NULL DEFAULT 0 CHECK (discount_syp >= 0),
    wallet_redeemed_syp INTEGER NOT NULL DEFAULT 0 CHECK (wallet_redeemed_syp >= 0),
    delivery_fee_syp INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee_syp >= 0),
    total_syp INTEGER NOT NULL CHECK (total_syp >= 0),
    points_earned REAL NOT NULL DEFAULT 0,
    points_redeemed REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    payment_method TEXT NOT NULL DEFAULT 'cod',
    payment_status TEXT NOT NULL DEFAULT 'pending',
    notes TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    unit_price_syp INTEGER NOT NULL CHECK (unit_price_syp >= 0),
    quantity REAL NOT NULL CHECK (quantity > 0),
    weight_volume TEXT NOT NULL DEFAULT '',
    line_total_syp INTEGER NOT NULL CHECK (line_total_syp >= 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    balance_syp INTEGER NOT NULL DEFAULT 0 CHECK (balance_syp >= 0),
    points_balance REAL NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    points_delta REAL NOT NULL DEFAULT 0,
    balance_points REAL NOT NULL DEFAULT 0,
    cash_delta_syp INTEGER NOT NULL DEFAULT 0,
    balance_syp INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_credentials (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payment_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    file_size INTEGER NOT NULL DEFAULT 0,
    operation_number TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS shipment_manifests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'local_delivery',
    manifest_number TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'dispatched',
    payload_json TEXT NOT NULL DEFAULT '{}',
    dispatched_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);
  CREATE INDEX IF NOT EXISTS idx_products_category_active ON products(category_id, is_active);
  CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_loyalty_wallet_created ON loyalty_transactions(wallet_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_payment_receipts_order ON payment_receipts(order_id);
`;

const seededCategories = [
  { slug: 'fruits', title: 'فواكه', image_url: 'https://images.unsplash.com/photo-1610832958506-aa56368176cf?auto=format&fit=crop&w=900&q=85', sort_order: 1 },
  { slug: 'vegetables', title: 'خضروات', image_url: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=900&q=85', sort_order: 2 },
  { slug: 'dairy', title: 'ألبان وأجبان', image_url: 'https://images.unsplash.com/photo-1628088062854-d1870b4553da?auto=format&fit=crop&w=900&q=85', sort_order: 3 },
  { slug: 'bakery', title: 'مخبوزات', image_url: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=900&q=85', sort_order: 4 },
  { slug: 'pantry', title: 'مواد غذائية', image_url: 'https://images.unsplash.com/photo-1604719312566-8912e9c8a213?auto=format&fit=crop&w=900&q=85', sort_order: 5 },
  { slug: 'beverages', title: 'مشروبات', image_url: 'https://images.unsplash.com/photo-1544145945-f90425340c7e?auto=format&fit=crop&w=900&q=85', sort_order: 6 },
];

const seededProducts = [
  { sku: 'FR-001', category: 'fruits', title: 'تفاح أحمر طازج', description: 'تفاح محلي مقرمش ومنتقى بعناية.', price: 12000, weight_volume: '١ كغ', image_url: 'https://images.unsplash.com/photo-1560806887-1e4cd0b6cbd6?auto=format&fit=crop&w=900&q=85', quantity: 45, discount_percent: 0, is_featured: 1 },
  { sku: 'FR-002', category: 'fruits', title: 'موز بلدي', description: 'موز طازج مناسب للفطور والوجبات الخفيفة.', price: 9500, weight_volume: '١ كغ', image_url: 'https://images.unsplash.com/photo-1571771894821-ce9b6c11b08e?auto=format&fit=crop&w=900&q=85', quantity: 38, discount_percent: 5, is_featured: 1 },
  { sku: 'VE-001', category: 'vegetables', title: 'بندورة حمراء', description: 'بندورة ناضجة وطازجة من المزرعة.', price: 7000, weight_volume: '١ كغ', image_url: 'https://images.unsplash.com/photo-1546094096-0df4bcaaa337?auto=format&fit=crop&w=900&q=85', quantity: 60, discount_percent: 0, is_featured: 1 },
  { sku: 'VE-002', category: 'vegetables', title: 'خيار بلدي', description: 'خيار أخضر مقرمش.', price: 6000, weight_volume: '١ كغ', image_url: 'https://images.unsplash.com/photo-1604977042946-1eecc30f269e?auto=format&fit=crop&w=900&q=85', quantity: 42, discount_percent: 0, is_featured: 0 },
  { sku: 'DA-001', category: 'dairy', title: 'حليب طازج', description: 'حليب كامل الدسم مبستر.', price: 8500, weight_volume: '١ لتر', image_url: 'https://images.unsplash.com/photo-1563636619-e9143da7973b?auto=format&fit=crop&w=900&q=85', quantity: 25, discount_percent: 0, is_featured: 1 },
  { sku: 'DA-002', category: 'dairy', title: 'لبنة بلدية', description: 'لبنة كريمية من الحليب الطازج.', price: 14000, weight_volume: '٥٠٠ غ', image_url: 'https://images.unsplash.com/photo-1486297678162-eb2a19b0a32d?auto=format&fit=crop&w=900&q=85', quantity: 18, discount_percent: 10, is_featured: 0 },
  { sku: 'BA-001', category: 'bakery', title: 'خبز عربي طازج', description: 'خبز عربي طري، يخبز يومياً.', price: 2500, weight_volume: 'ربطة', image_url: 'https://images.unsplash.com/photo-1585478259715-876acc5be8eb?auto=format&fit=crop&w=900&q=85', quantity: 80, discount_percent: 0, is_featured: 0 },
  { sku: 'PA-001', category: 'pantry', title: 'زيت زيتون سوري', description: 'زيت زيتون بكر ممتاز من موسم هذا العام.', price: 68000, weight_volume: '١ لتر', image_url: 'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?auto=format&fit=crop&w=900&q=85', quantity: 12, discount_percent: 8, is_featured: 1 },
  { sku: 'PA-002', category: 'pantry', title: 'أرز قصير الحبة', description: 'أرز أبيض منتقى للطبخ اليومي.', price: 16000, weight_volume: '١ كغ', image_url: 'https://images.unsplash.com/photo-1586201375761-83865001e31c?auto=format&fit=crop&w=900&q=85', quantity: 30, discount_percent: 0, is_featured: 0 },
  { sku: 'BE-001', category: 'beverages', title: 'عصير برتقال طبيعي', description: 'عصير منعش بطعم البرتقال الطبيعي.', price: 9000, weight_volume: '١ لتر', image_url: 'https://images.unsplash.com/photo-1600271886742-f049cd451bba?auto=format&fit=crop&w=900&q=85', quantity: 22, discount_percent: 0, is_featured: 1 },
];

const seededSettings = {
  'store.name': 'كويك ماركت',
  'store.currency': 'ل.س',
  'store.city': 'دمشق',
  'payments.cod_enabled': true,
  'payments.cham_cash_enabled': true,
  'cham_cash.owner_name': process.env.CHAM_CASH_OWNER || 'كويك ماركت',
  'cham_cash.wallet_number': process.env.CHAM_CASH_WALLET || '0000000000',
  'cham_cash.qr_code_image': '',
  'loyalty.points_per_100_syp': 0.1,
  'loyalty.syp_per_point': 10,
  'loyalty.max_points_per_order': 200,
};

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setSetting(key, value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, serialized);
}

export function initDatabase() {
  db.exec(schema);

  const seed = db.transaction(() => {
    const addCategory = db.prepare(`
      INSERT OR IGNORE INTO categories (slug, title, image_url, sort_order)
      VALUES (@slug, @title, @image_url, @sort_order)
    `);
    for (const category of seededCategories) addCategory.run(category);

    const addProduct = db.prepare(`
      INSERT OR IGNORE INTO products
        (sku, category_id, title, description, price, discount_percent, weight_volume,
         image_url, quantity, is_featured)
      VALUES
        (@sku, (SELECT id FROM categories WHERE slug = @category), @title, @description,
         @price, @discount_percent, @weight_volume, @image_url, @quantity, @is_featured)
    `);
    for (const product of seededProducts) addProduct.run(product);

    const addSetting = db.prepare(`
      INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)
    `);
    for (const [key, value] of Object.entries(seededSettings)) {
      addSetting.run(key, JSON.stringify(value));
    }

    const previousBrandName = '\u0645\u0627\u0631\u0643\u062a \u0633\u0645\u0627';
    const migrateBrandDefault = db.prepare(`
      UPDATE settings SET value=?, updated_at=datetime('now')
      WHERE key=? AND value IN (?, ?)
    `);
    for (const key of ['store.name', 'cham_cash.owner_name']) {
      migrateBrandDefault.run(JSON.stringify('كويك ماركت'), key, JSON.stringify(previousBrandName), previousBrandName);
    }

    const adminUsername = String(process.env.ADMIN_USERNAME || 'admin').trim().slice(0, 100) || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    db.prepare(`
      INSERT OR IGNORE INTO admin_credentials (username, password_hash)
      VALUES (?, ?)
    `).run(adminUsername, hashPassword(adminPassword));
  });

  seed();
  return db;
}
