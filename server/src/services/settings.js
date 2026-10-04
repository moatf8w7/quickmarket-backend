import { db, getSetting, setSetting } from '../db/index.js';

export const DEFAULT_SETTINGS = {
  storeName: 'كويك ماركت',
  chamCash: { ownerName: 'كويك ماركت', walletNumber: '0000000000', qrCodeImage: '' },
  loyalty: { pointsPer100Syp: 0.1, sypPerPoint: 10, maxPointsPerOrder: 200 },
  deliveryFee: 0,
  currency: 'ل.س',
};

export function getSettings() {
  return {
    storeName: getSetting('store.name', DEFAULT_SETTINGS.storeName),
    currency: getSetting('store.currency', DEFAULT_SETTINGS.currency),
    deliveryFee: Number(getSetting('delivery.fee_syp', DEFAULT_SETTINGS.deliveryFee)) || 0,
    chamCash: {
      ownerName: getSetting('cham_cash.owner_name', DEFAULT_SETTINGS.chamCash.ownerName),
      walletNumber: getSetting('cham_cash.wallet_number', DEFAULT_SETTINGS.chamCash.walletNumber),
      qrCodeImage: getSetting('cham_cash.qr_code_image', DEFAULT_SETTINGS.chamCash.qrCodeImage),
    },
    loyalty: {
      pointsPer100Syp: Number(getSetting('loyalty.points_per_100_syp', DEFAULT_SETTINGS.loyalty.pointsPer100Syp)),
      sypPerPoint: Number(getSetting('loyalty.syp_per_point', DEFAULT_SETTINGS.loyalty.sypPerPoint)),
      maxPointsPerOrder: Number(getSetting('loyalty.max_points_per_order', DEFAULT_SETTINGS.loyalty.maxPointsPerOrder)),
    },
    codEnabled: getSetting('payments.cod_enabled', true),
    chamCashEnabled: getSetting('payments.cham_cash_enabled', true),
  };
}

export function writeSetting(key, value) {
  setSetting(key, value);
}

export function updateSettings(patch) {
  const allowed = new Set(['storeName', 'chamCash', 'loyalty', 'deliveryFee', 'currency']);
  const transaction = db.transaction(() => {
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error(`Unsupported setting: ${key}`);
    if (Object.hasOwn(patch, 'storeName')) writeSetting('store.name', String(patch.storeName).trim());
    if (Object.hasOwn(patch, 'chamCash')) {
      const config = patch.chamCash;
      writeSetting('cham_cash.owner_name', config.ownerName ?? config.owner_name ?? '');
      writeSetting('cham_cash.wallet_number', config.walletNumber ?? config.wallet_number ?? '');
      writeSetting('cham_cash.qr_code_image', config.qrCodeImage ?? config.qr_code_image ?? '');
    }
    if (Object.hasOwn(patch, 'loyalty')) {
      const config = patch.loyalty;
      writeSetting('loyalty.points_per_100_syp', Number(config.pointsPer100Syp ?? config.points_per_100_syp));
      writeSetting('loyalty.syp_per_point', Number(config.sypPerPoint ?? config.syp_per_point));
      writeSetting('loyalty.max_points_per_order', Number(config.maxPointsPerOrder ?? config.max_points_per_order));
    }
    if (Object.hasOwn(patch, 'deliveryFee')) writeSetting('delivery.fee_syp', patch.deliveryFee);
    if (Object.hasOwn(patch, 'currency')) writeSetting('store.currency', patch.currency);
  });
  transaction();
  return getSettings();
}

