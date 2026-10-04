export class HttpError extends Error {
  constructor(status, message, code = 'request_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

export function requireValue(value, message, status = 400) {
  if (value === undefined || value === null || value === '') {
    throw new HttpError(status, message);
  }
  return value;
}

export function parseId(value, label = 'المعرّف') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, `${label} غير صالح`);
  return id;
}

export function imageDataUrl(value, { required = false, label = 'الصورة' } = {}) {
  if (!value && !required) return null;
  if (typeof value !== 'string' || value.length > 12 * 1024 * 1024 ||
      !/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value)) {
    throw new HttpError(400, `${label} يجب أن تكون صورة PNG أو JPEG أو WebP أو GIF بصيغة صالحة`);
  }
  return value;
}

export function toInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new HttpError(400, `${label} غير صالح`);
  }
  return number;
}

export function publicUser(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, phone: row.phone, email: row.email ?? null };
}

export function productDto(row, category = undefined) {
  if (!row) return null;
  return {
    ...row,
    categoryId: row.category_id,
    discountPercent: row.discount_percent,
    weightVolume: row.weight_volume,
    image: row.enhanced_image_url || row.image_url,
    imageUrl: row.enhanced_image_url || row.image_url,
    active: Boolean(row.is_active),
    ...(category === undefined ? {} : { category }),
  };
}

export function categoryDto(row, itemCount = undefined) {
  if (!row) return null;
  return {
    ...row,
    image: row.image_url,
    imageUrl: row.image_url,
    active: Boolean(row.is_active),
    ...(itemCount === undefined ? {} : { itemCount }),
  };
}

export function orderCode(id) {
  return `MS-${String(id).padStart(6, '0')}`;
}

export function safeJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}
