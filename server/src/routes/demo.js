import { Router } from 'express';
import { db, getSetting, setSetting } from '../db.js';

const router = Router();

// 首次引导用的示例商品。sku 统一加 DEMO- 前缀，便于人工识别。
const DEMO_PRODUCTS = [
  { name: '矿泉水 550ml', sku: 'DEMO-001', category: '饮品', spec: '550ml', purchase_price: 1.0, sale_price: 2.0, stock_low: 24 },
  { name: '方便面（红烧牛肉）', sku: 'DEMO-002', category: '食品', spec: '袋装', purchase_price: 2.5, sale_price: 4.0, stock_low: 10 },
  { name: '抽纸（软包）', sku: 'DEMO-003', category: '日用品', spec: '3层', purchase_price: 3.2, sale_price: 5.0, stock_low: 6 }
];

function baseUnitId() {
  const u = db.prepare("SELECT id FROM units WHERE dimension='count' AND is_base=1 ORDER BY sort_order LIMIT 1").get();
  return u ? u.id : null;
}

function readSeedIds() {
  try {
    const ids = JSON.parse(getSetting('demo_seed_ids', '') || '[]');
    return Array.isArray(ids) ? ids.filter(n => Number.isInteger(n)) : [];
  } catch { return []; }
}

// 写入示例商品，并记录 id 供后续一键清除
router.post('/demo/seed', (req, res) => {
  const existing = readSeedIds();
  if (existing.length) return res.json({ ok: true, ids: existing, already: true });

  const unitId = baseUnitId();
  const ins = db.prepare(`INSERT INTO products
    (name, sku, category, spec, base_unit_id, purchase_price, sale_price, stock_low, remark, custom_data)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const ids = [];
  db.transaction(() => {
    for (const p of DEMO_PRODUCTS) {
      const info = ins.run(p.name, p.sku, p.category, p.spec, unitId,
        p.purchase_price, p.sale_price, p.stock_low, '示例商品，可一键清除', '{}');
      ids.push(Number(info.lastInsertRowid));
    }
    setSetting('demo_seed_ids', JSON.stringify(ids));
  })();
  res.json({ ok: true, ids });
});

// 清除示例商品：已产生进出货流水的商品拒绝删除（外键会阻止，这里提前给出人话提示）
router.post('/demo/clear', (req, res) => {
  const ids = readSeedIds();
  if (!ids.length) return res.json({ ok: true, removed: 0, kept: 0 });

  const used = db.prepare(`SELECT
      (SELECT COUNT(*) FROM stock_ledger WHERE product_id=?) +
      (SELECT COUNT(*) FROM purchase_order_items WHERE product_id=?) +
      (SELECT COUNT(*) FROM sales_order_items WHERE product_id=?) AS c`);

  const removable = [];
  const kept = [];
  for (const id of ids) (used.get(id, id, id).c > 0 ? kept : removable).push(id);

  const del = db.prepare('DELETE FROM products WHERE id=?');
  db.transaction(() => { for (const id of removable) del.run(id); })();
  setSetting('demo_seed_ids', kept.length ? JSON.stringify(kept) : '');

  res.json({ ok: true, removed: removable.length, kept: kept.length });
});

export default router;