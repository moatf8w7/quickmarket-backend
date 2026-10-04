import { Router } from 'express';
import { db } from '../db/index.js';
import { categoryDto, productDto } from '../services/http.js';
import { getSettings } from '../services/settings.js';

const router = Router();

router.get('/', (_req, res) => {
  const categories = db.prepare(`SELECT c.*, COUNT(p.id) AS item_count
    FROM categories c LEFT JOIN products p ON p.category_id=c.id AND p.is_active=1
    WHERE c.is_active=1 GROUP BY c.id ORDER BY c.sort_order, c.title`).all();
  const productRows = db.prepare(`SELECT p.*, c.id AS c_id, c.slug AS c_slug, c.title AS c_title,
    c.image_url AS c_image_url, c.sort_order AS c_sort_order, c.is_active AS c_is_active
    FROM products p JOIN categories c ON c.id=p.category_id
    WHERE p.is_active=1 AND c.is_active=1 ORDER BY p.id DESC`).all();
  const products = productRows.map((row) => {
    const category = categoryDto({ id: row.c_id, slug: row.c_slug, title: row.c_title,
      image_url: row.c_image_url, sort_order: row.c_sort_order, is_active: row.c_is_active });
    const { c_id, c_slug, c_title, c_image_url, c_sort_order, c_is_active, ...product } = row;
    return productDto(product, category);
  });
  res.json({ categories: categories.map((row) => categoryDto(row, row.item_count)), products,
    offers: products.filter((product) => Number(product.discount_percent) > 0), settings: getSettings() });
});

export default router;

