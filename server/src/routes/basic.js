import { Router } from 'express';
import { db, round, now } from '../db.js';

const router = Router();

// ---------- 单位 ----------
// 默认只返回启用项；includeInactive=1 时连停用的一起返回（「显示已停用」用）。
// 早期这里没有 active 过滤，停用的单位会一直留在下拉框里。
router.get('/units', (req, res) => {
  const includeInactive = req.query.includeInactive === '1';
  const rows = db.prepare(`SELECT * FROM units ${includeInactive ? '' : 'WHERE active=1'} ORDER BY sort_order, id`).all();
  res.json(rows);
});
router.post('/units', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '单位名称不能为空' });
  // 撞上已停用的同名记录时，引导用户去恢复，而不是抛 SQLite 的原始 UNIQUE 报错
  const dead = db.prepare('SELECT id FROM units WHERE name=? AND active=0').get(b.name);
  if (dead) return res.status(409).json({ error: '同名单位已被一条停用记录占用，可以恢复它', inactive_id: dead.id });
  try {
    const info = db.prepare(`INSERT INTO units (name, dimension, ratio, weight_per, is_base, sort_order)
      VALUES (?,?,?,?,?,?)`)
      .run(b.name, b.dimension === 'weight' ? 'weight' : 'count', round(b.ratio) || 1, b.weight_per ?? null, b.is_base ? 1 : 0, Number(b.sort_order) || 0);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: '名称已存在或参数不合法' }); }
});
router.put('/units/:id', (req, res) => {
  const b = req.body || {};
  try {
    db.prepare(`UPDATE units SET name=?, dimension=?, ratio=?, weight_per=?, is_base=?, sort_order=? WHERE id=?`)
      .run(b.name, b.dimension === 'weight' ? 'weight' : 'count', round(b.ratio) || 1, b.weight_per ?? null, b.is_base ? 1 : 0, Number(b.sort_order) || 0, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: '名称已存在或参数不合法' }); }
});
router.post('/units/:id/restore', (req, res) => {
  const r = db.prepare('UPDATE units SET active=1 WHERE id=?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: '单位不存在' });
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
  const includeInactive = req.query.includeInactive === '1' ? '1' : '';
  const rows = db.prepare(`
    SELECT p.*, u.name AS unit_name, COALESCE((SELECT SUM(s.quantity) FROM stock s WHERE s.product_id=p.id),0) AS stock_qty
    FROM products p LEFT JOIN units u ON u.id=p.base_unit_id
    WHERE (?='1' OR p.active=1) AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ? OR p.spec LIKE ?)
      AND (?='' OR p.category=?)
    ORDER BY p.id DESC LIMIT 500`).all(includeInactive, keyword, keyword, keyword, keyword, category, category);
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
  try {
    db.prepare(`UPDATE products SET name=?, sku=?, barcode=?, category=?, spec=?, base_unit_id=?, weight_per_base_kg=?, purchase_price=?, sale_price=?, stock_low=?, remark=?, custom_data=?, updated_at=?
      WHERE id=?`)
      .run(b.name, b.sku || '', b.barcode || '', b.category || '', b.spec || '', b.base_unit_id || null,
        round(b.weight_per_base_kg) || 0, round(b.purchase_price) || 0, round(b.sale_price) || 0, round(b.stock_low) || 0,
        b.remark || '', JSON.stringify(b.custom_data || {}), now(), req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: '保存失败：' + e.message }); }
});
router.post('/products/:id/restore', (req, res) => {
  const r = db.prepare('UPDATE products SET active=1 WHERE id=?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: '商品不存在' });
  res.json({ ok: true });
});
router.delete('/products/:id', (req, res) => {
  db.prepare('UPDATE products SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 供应商 / 客户 ----------
function partnerRoutes(entity, table) {
  router.get(`/${entity}`, (req, res) => {
    const includeInactive = req.query.includeInactive === '1';
    const rows = db.prepare(`SELECT * FROM ${table} ${includeInactive ? '' : 'WHERE active=1'} ORDER BY id DESC`).all();
    res.json(rows);
  });
  router.post(`/${entity}`, (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: '名称不能为空' });
    // 同名记录还在（只是被停用）时，引导用户恢复，而不是抛原始 UNIQUE 报错
    const dead = db.prepare(`SELECT id FROM ${table} WHERE name=? AND active=0`).get(b.name);
    if (dead) return res.status(409).json({ error: '同名记录已存在，但处于停用状态，可以恢复它', inactive_id: dead.id });
    try {
      const info = db.prepare(`INSERT INTO ${table} (name, contact, phone, address, remark, custom_data) VALUES (?,?,?,?,?,?)`)
        .run(b.name, b.contact || '', b.phone || '', b.address || '', b.remark || '', JSON.stringify(b.custom_data || {}));
      res.json({ id: Number(info.lastInsertRowid) });
    } catch (e) { res.status(400).json({ error: '名称已存在或参数不合法' }); }
  });
  router.put(`/${entity}/:id`, (req, res) => {
    const b = req.body || {};
    try {
      db.prepare(`UPDATE ${table} SET name=?, contact=?, phone=?, address=?, remark=?, custom_data=? WHERE id=?`)
        .run(b.name, b.contact || '', b.phone || '', b.address || '', b.remark || '', JSON.stringify(b.custom_data || {}), req.params.id);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: '名称已存在或参数不合法' }); }
  });
  router.post(`/${entity}/:id/restore`, (req, res) => {
    const r = db.prepare(`UPDATE ${table} SET active=1 WHERE id=?`).run(req.params.id);
    if (!r.changes) return res.status(404).json({ error: '记录不存在' });
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
  const includeInactive = req.query.includeInactive === '1';
  const rows = db.prepare(`SELECT * FROM warehouses ${includeInactive ? '' : 'WHERE active=1'} ORDER BY id`).all();
  res.json(rows);
});
router.post('/warehouses', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '仓库名称不能为空' });
  const dead = db.prepare('SELECT id FROM warehouses WHERE name=? AND active=0').get(b.name);
  if (dead) return res.status(409).json({ error: '同名仓库已存在，但处于停用状态，可以恢复它', inactive_id: dead.id });
  try {
    const info = db.prepare('INSERT INTO warehouses (name, code, address, remark) VALUES (?,?,?,?)')
      .run(b.name, b.code || '', b.address || '', b.remark || '');
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: '名称已存在或参数不合法' }); }
});
router.put('/warehouses/:id', (req, res) => {
  const b = req.body || {};
  try {
    db.prepare('UPDATE warehouses SET name=?, code=?, address=?, remark=? WHERE id=?')
      .run(b.name, b.code || '', b.address || '', b.remark || '', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: '名称已存在或参数不合法' }); }
});
router.post('/warehouses/:id/restore', (req, res) => {
  const r = db.prepare('UPDATE warehouses SET active=1 WHERE id=?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: '仓库不存在' });
  res.json({ ok: true });
});
router.delete('/warehouses/:id', (req, res) => {
  db.prepare('UPDATE warehouses SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 自定义字段 ----------
router.get('/custom-fields', (req, res) => {
  const entity = req.query.entity || '';
  const includeInactive = req.query.includeInactive === '1' ? '1' : '';
  const rows = db.prepare('SELECT * FROM custom_field_defs WHERE (?=\'1\' OR active=1) AND (?=\'\' OR entity=?) ORDER BY entity, sort_order, id').all(includeInactive, entity, entity);
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
router.post('/custom-fields/:id/restore', (req, res) => {
  const r = db.prepare('UPDATE custom_field_defs SET active=1 WHERE id=?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: '字段不存在' });
  res.json({ ok: true });
});
router.delete('/custom-fields/:id', (req, res) => {
  db.prepare('UPDATE custom_field_defs SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
