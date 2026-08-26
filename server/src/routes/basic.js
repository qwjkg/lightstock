import { Router } from 'express';
import { db, round, now } from '../db.js';

const router = Router();

// ---------- 单位 ----------
router.get('/units', (req, res) => {
  const rows = db.prepare('SELECT * FROM units ORDER BY sort_order, id').all();
  res.json(rows);
});
router.post('/units', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '单位名称不能为空' });
  try {
    const info = db.prepare(`INSERT INTO units (name, dimension, ratio, weight_per, is_base, sort_order)
      VALUES (?,?,?,?,?,?)`)
      .run(b.name, b.dimension === 'weight' ? 'weight' : 'count', round(b.ratio) || 1, b.weight_per ?? null, b.is_base ? 1 : 0, Number(b.sort_order) || 0);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/units/:id', (req, res) => {
  const b = req.body || {};
  db.prepare(`UPDATE units SET name=?, dimension=?, ratio=?, weight_per=?, is_base=?, sort_order=? WHERE id=?`)
    .run(b.name, b.dimension === 'weight' ? 'weight' : 'count', round(b.ratio) || 1, b.weight_per ?? null, b.is_base ? 1 : 0, Number(b.sort_order) || 0, req.params.id);
  res.json({ ok: true });
});
router.delete('/units/:id', (req, res) => {
  db.prepare('UPDATE units SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 商品 ----------
router.get('/products', (req, res) => {
  const keyword = req.query.keyword ? `%${req.query.keyword}%` : '%';
  const category = req.query.category || '';
  const rows = db.prepare(`
    SELECT p.*, u.name AS unit_name, COALESCE((SELECT SUM(s.quantity) FROM stock s WHERE s.product_id=p.id),0) AS stock_qty
    FROM products p LEFT JOIN units u ON u.id=p.base_unit_id
    WHERE p.active=1 AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ? OR p.spec LIKE ?)
      AND (?='' OR p.category=?)
    ORDER BY p.id DESC LIMIT 500`).all(keyword, keyword, keyword, keyword, category, category);
  res.json(rows);
});
router.get('/products/categories', (req, res) => {
  const rows = db.prepare("SELECT DISTINCT category FROM products WHERE category<>'' AND active=1 ORDER BY category").all();
  res.json(rows.map(r => r.category));
});
router.post('/products', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '商品名称不能为空' });
  const info = db.prepare(`INSERT INTO products (name, sku, barcode, category, spec, base_unit_id, weight_per_base_kg, purchase_price, sale_price, stock_low, remark, custom_data)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.name, b.sku || '', b.barcode || '', b.category || '', b.spec || '', b.base_unit_id || null,
      round(b.weight_per_base_kg) || 0, round(b.purchase_price) || 0, round(b.sale_price) || 0, round(b.stock_low) || 0,
      b.remark || '', JSON.stringify(b.custom_data || {}));
  res.json({ id: Number(info.lastInsertRowid) });
});
router.put('/products/:id', (req, res) => {
  const b = req.body || {};
  db.prepare(`UPDATE products SET name=?, sku=?, barcode=?, category=?, spec=?, base_unit_id=?, weight_per_base_kg=?, purchase_price=?, sale_price=?, stock_low=?, remark=?, custom_data=?, updated_at=?
    WHERE id=?`)
    .run(b.name, b.sku || '', b.barcode || '', b.category || '', b.spec || '', b.base_unit_id || null,
      round(b.weight_per_base_kg) || 0, round(b.purchase_price) || 0, round(b.sale_price) || 0, round(b.stock_low) || 0,
      b.remark || '', JSON.stringify(b.custom_data || {}), now(), req.params.id);
  res.json({ ok: true });
});
router.delete('/products/:id', (req, res) => {
  db.prepare('UPDATE products SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 供应商 / 客户 ----------
function partnerRoutes(entity, table) {
  router.get(`/${entity}`, (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE active=1 ORDER BY id DESC`).all();
    res.json(rows);
  });
  router.post(`/${entity}`, (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: '名称不能为空' });
    try {
      const info = db.prepare(`INSERT INTO ${table} (name, contact, phone, address, remark, custom_data) VALUES (?,?,?,?,?,?)`)
        .run(b.name, b.contact || '', b.phone || '', b.address || '', b.remark || '', JSON.stringify(b.custom_data || {}));
      res.json({ id: Number(info.lastInsertRowid) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.put(`/${entity}/:id`, (req, res) => {
    const b = req.body || {};
    db.prepare(`UPDATE ${table} SET name=?, contact=?, phone=?, address=?, remark=?, custom_data=? WHERE id=?`)
      .run(b.name, b.contact || '', b.phone || '', b.address || '', b.remark || '', JSON.stringify(b.custom_data || {}), req.params.id);
    res.json({ ok: true });
  });
  router.delete(`/${entity}/:id`, (req, res) => {
    db.prepare(`UPDATE ${table} SET active=0 WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  });
}
partnerRoutes('suppliers', 'suppliers');
partnerRoutes('customers', 'customers');

// ---------- 仓库 ----------
router.get('/warehouses', (req, res) => {
  const rows = db.prepare('SELECT * FROM warehouses WHERE active=1 ORDER BY id').all();
  res.json(rows);
});
router.post('/warehouses', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '仓库名称不能为空' });
  try {
    const info = db.prepare('INSERT INTO warehouses (name, code, address, remark) VALUES (?,?,?,?)')
      .run(b.name, b.code || '', b.address || '', b.remark || '');
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/warehouses/:id', (req, res) => {
  const b = req.body || {};
  db.prepare('UPDATE warehouses SET name=?, code=?, address=?, remark=? WHERE id=?')
    .run(b.name, b.code || '', b.address || '', b.remark || '', req.params.id);
  res.json({ ok: true });
});
router.delete('/warehouses/:id', (req, res) => {
  db.prepare('UPDATE warehouses SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 自定义字段 ----------
router.get('/custom-fields', (req, res) => {
  const entity = req.query.entity || '';
  const rows = db.prepare('SELECT * FROM custom_field_defs WHERE active=1 AND (?=\'\' OR entity=?) ORDER BY entity, sort_order, id').all(entity, entity);
  res.json(rows);
});
router.post('/custom-fields', (req, res) => {
  const b = req.body || {};
  if (!b.entity || !b.name || !b.label) return res.status(400).json({ error: '实体、字段名、显示名不能为空' });
  if (!['product', 'supplier', 'customer', 'purchase_order', 'sales_order'].includes(b.entity))
    return res.status(400).json({ error: '实体类型不合法' });
  try {
    const info = db.prepare(`INSERT INTO custom_field_defs (entity, name, label, field_type, options, required, sort_order)
      VALUES (?,?,?,?,?,?,?)`)
      .run(b.entity, b.name, b.label, b.field_type || 'text', JSON.stringify(b.options || []), b.required ? 1 : 0, Number(b.sort_order) || 0);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: '字段已存在或参数不合法' }); }
});
router.put('/custom-fields/:id', (req, res) => {
  const b = req.body || {};
  db.prepare(`UPDATE custom_field_defs SET name=?, label=?, field_type=?, options=?, required=?, sort_order=? WHERE id=?`)
    .run(b.name, b.label, b.field_type || 'text', JSON.stringify(b.options || []), b.required ? 1 : 0, Number(b.sort_order) || 0, req.params.id);
  res.json({ ok: true });
});
router.delete('/custom-fields/:id', (req, res) => {
  db.prepare('UPDATE custom_field_defs SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
