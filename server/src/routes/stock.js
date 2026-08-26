import { Router } from 'express';
import { db, round } from '../db.js';
import { adjustStock } from '../services/stock.js';

const router = Router();

router.get('/stock', (req, res) => {
  const warehouseId = req.query.warehouseId || '';
  const productId = req.query.productId || '';
  const lowOnly = req.query.lowOnly === '1';
  const keyword = req.query.keyword ? `%${req.query.keyword}%` : '%';
  const rows = db.prepare(`
    SELECT s.product_id, s.warehouse_id, s.quantity, p.name, p.sku, p.category, p.spec, p.base_unit_id,
      u.name AS unit_name, p.weight_per_base_kg, p.avg_cost, p.stock_low, w.name AS warehouse_name,
      ROUND(s.quantity * p.weight_per_base_kg, 3) AS weight_kg,
      ROUND(s.quantity * p.avg_cost, 2) AS stock_value
    FROM stock s
    JOIN products p ON p.id=s.product_id
    LEFT JOIN units u ON u.id=p.base_unit_id
    JOIN warehouses w ON w.id=s.warehouse_id
    WHERE (?='' OR s.warehouse_id=?) AND (?='' OR s.product_id=?)
      AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)
    ORDER BY p.category, p.name`).all(warehouseId, warehouseId, productId, productId, keyword, keyword, keyword);
  let result = rows;
  if (lowOnly) result = rows.filter(r => r.stock_low > 0 && r.quantity < r.stock_low);
  res.json(result);
});

router.get('/stock/low', (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.sku, p.category, p.stock_low, p.base_unit_id, u.name AS unit_name,
      COALESCE(SUM(s.quantity),0) AS qty
    FROM products p LEFT JOIN units u ON u.id=p.base_unit_id
    LEFT JOIN stock s ON s.product_id=p.id
    WHERE p.active=1 AND p.stock_low>0
    GROUP BY p.id HAVING COALESCE(SUM(s.quantity),0) < p.stock_low
    ORDER BY (p.stock_low - COALESCE(SUM(s.quantity),0)) DESC LIMIT 100`).all();
  res.json(rows);
});

router.post('/stock/adjust', (req, res) => {
  try { res.json(adjustStock(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/ledger', (req, res) => {
  const productId = req.query.productId || '';
  const warehouseId = req.query.warehouseId || '';
  const type = req.query.type || '';
  const from = req.query.from || '';
  const to = req.query.to || '';
  const keyword = req.query.keyword ? `%${req.query.keyword}%` : '%';
  const rows = db.prepare(`
    SELECT l.*, p.name AS product_name, p.sku AS product_sku, w.name AS warehouse_name, u.name AS unit_name
    FROM stock_ledger l
    JOIN products p ON p.id=l.product_id
    LEFT JOIN warehouses w ON w.id=l.warehouse_id
    LEFT JOIN units u ON u.id=l.unit_id
    WHERE (?='' OR l.product_id=?) AND (?='' OR l.warehouse_id=?) AND (?='' OR l.type=?)
      AND (?='' OR date(l.created_at)>=?) AND (?='' OR date(l.created_at)<=?)
      AND (l.remark LIKE ? OR l.ref_no LIKE ?)
    ORDER BY l.id DESC LIMIT 1000`).all(productId, productId, warehouseId, warehouseId, type, type, from, from, to, to, keyword, keyword);
  res.json(rows);
});

export default router;
