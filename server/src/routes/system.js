import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { db, dataDir, getSetting, setSetting, round, DB_PATH } from '../db.js';
import { resetTokens } from '../auth.js';

const router = Router();

router.get('/settings', (req, res) => {
  res.json({
    business_name: getSetting('business_name', '我的店铺'),
    auto_backup_hours: Number(getSetting('auto_backup_hours', '6')),
    password_required: !!getSetting('access_password'),
    // ui_mode / onboarded 由 db.js 在启动时一次性落定，这里只读。
    // 曾经这里按「库里有没有业务数据」现算，导致用户录入第一个商品时界面自己变模式。
    ui_mode: getSetting('ui_mode', 'simple'),
    onboarded: getSetting('onboarded', '1') === '1',
    has_demo: !!getSetting('demo_seed_ids', '')
  });
});
router.put('/settings', (req, res) => {
  const b = req.body || {};
  if (b.business_name !== undefined) setSetting('business_name', b.business_name);
  if (b.auto_backup_hours !== undefined) setSetting('auto_backup_hours', Number(b.auto_backup_hours) || 6);
  if (b.ui_mode !== undefined) setSetting('ui_mode', b.ui_mode === 'advanced' ? 'advanced' : 'simple');
  if (b.onboarded !== undefined) setSetting('onboarded', b.onboarded ? '1' : '0');
  if (b.access_password !== undefined) {
    setSetting('access_password', b.access_password ? String(b.access_password) : '');
    resetTokens();
  }
  res.json({ ok: true });
});

// ---------- 备份 ----------
function backupDir() { return path.join(dataDir, 'backups'); }
function listBackups() {
  fs.mkdirSync(backupDir(), { recursive: true });
  return fs.readdirSync(backupDir())
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const st = fs.statSync(path.join(backupDir(), f));
      return { name: f, size: st.size, time: st.mtime.toISOString().slice(0, 19).replace('T', ' ') };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}
export function createBackupFile() {
  fs.mkdirSync(backupDir(), { recursive: true });
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const target = path.join(backupDir(), `warehouse-${ts}.db`);
  return new Promise((resolve, reject) => {
    db.backup(target).then(() => {
      // 只保留最近 30 份
      const files = listBackups();
      for (const f of files.slice(30)) {
        try { fs.unlinkSync(path.join(backupDir(), f.name)); } catch { /* ignore */ }
      }
      resolve(target);
    }).catch(reject);
  });
}
router.post('/backups', async (req, res) => {
  try { await createBackupFile(); res.json({ list: listBackups() }); }
  catch (e) { res.status(500).json({ error: '备份失败：' + e.message }); }
});
router.get('/backups', (req, res) => res.json(listBackups()));
router.get('/backups/download', (req, res) => {
  const name = path.basename(String(req.query.file || ''));
  const file = path.join(backupDir(), name);
  if (!name.endsWith('.db') || !fs.existsSync(file)) return res.status(404).json({ error: '备份文件不存在' });
  res.download(file);
});

// ---------- 商品 Excel 导入（rows 由前端 xlsx 解析后提交 JSON） ----------
router.post('/import/products', (req, res) => {
  const rows = (req.body && req.body.rows) || [];
  if (!rows.length) return res.status(400).json({ error: '没有可导入的数据' });
  const findUnit = db.prepare('SELECT * FROM units WHERE name=? AND active=1');
  const upsert = db.prepare(`
    INSERT INTO products (name, sku, barcode, category, spec, base_unit_id, weight_per_base_kg, purchase_price, sale_price, stock_low, remark, custom_data)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT DO NOTHING`);
  const findProduct = db.prepare('SELECT * FROM products WHERE name=? AND active=1');
  const update = db.prepare(`UPDATE products SET sku=?, barcode=?, category=?, spec=?, base_unit_id=?, weight_per_base_kg=?, purchase_price=?, sale_price=?, stock_low=?, remark=?, updated_at=datetime('now','localtime') WHERE id=?`);
  let ok = 0, skipped = 0;
  for (const r of rows) {
    if (!r.name) { skipped++; continue; }
    let unitId = null;
    if (r.base_unit) {
      const u = findUnit.get(r.base_unit);
      if (u) unitId = u.id;
    }
    const exist = findProduct.get(r.name);
    if (exist) {
      update.run(r.sku || '', r.barcode || '', r.category || '', r.spec || '', unitId, round(r.weight_per_base_kg) || 0,
        round(r.purchase_price) || 0, round(r.sale_price) || 0, round(r.stock_low) || 0, r.remark || '', exist.id);
    } else {
      upsert.run(r.name, r.sku || '', r.barcode || '', r.category || '', r.spec || '', unitId, round(r.weight_per_base_kg) || 0,
        round(r.purchase_price) || 0, round(r.sale_price) || 0, round(r.stock_low) || 0, r.remark || '', '{}');
    }
    ok++;
  }
  res.json({ ok, skipped, total: rows.length });
});

// ---------- Excel 导出 ----------
function sendWorkbook(res, workbook, filename) {
  const buf = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(filename)}`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}
router.get('/export/products', (req, res) => {
  const rows = db.prepare(`SELECT name AS 名称, category AS 分类, spec AS 规格, barcode AS 条码, sku AS 编号,
    COALESCE((SELECT name FROM units WHERE id=p.base_unit_id),'') AS 基准单位, purchase_price AS 默认进价, sale_price AS 默认售价,
    stock_low AS 低库存阈值, weight_per_base_kg AS 每基准单位重量kg, remark AS 备注
    FROM products p WHERE active=1 ORDER BY id`).all();
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '商品');
  sendWorkbook(res, wb, '商品清单.xlsx');
});
router.get('/export/stock', (req, res) => {
  const rows = db.prepare(`SELECT p.name AS 商品, p.category AS 分类, p.spec AS 规格, w.name AS 仓库,
    s.quantity AS 库存基准数量, COALESCE((SELECT name FROM units WHERE id=p.base_unit_id),'') AS 基准单位,
    ROUND(s.quantity * p.weight_per_base_kg,3) AS 重量kg, ROUND(p.avg_cost,2) AS 平均成本,
    ROUND(s.quantity * p.avg_cost,2) AS 库存金额
    FROM stock s JOIN products p ON p.id=s.product_id JOIN warehouses w ON w.id=s.warehouse_id
    ORDER BY p.category, p.name`).all();
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '库存');
  sendWorkbook(res, wb, '库存清单.xlsx');
});
router.get('/export/purchase', (req, res) => {
  const rows = db.prepare(`SELECT o.order_no AS 单号, o.order_date AS 日期, sp.name AS 供应商, w.name AS 仓库,
    p.name AS 商品, i.quantity AS 数量, COALESCE(u.name,'') AS 单位, i.unit_price AS 单价, i.amount AS 金额, o.remark AS 备注
    FROM purchase_order_items i JOIN purchase_orders o ON o.id=i.order_id JOIN products p ON p.id=i.product_id
    LEFT JOIN suppliers sp ON sp.id=o.supplier_id LEFT JOIN warehouses w ON w.id=o.warehouse_id LEFT JOIN units u ON u.id=i.unit_id
    WHERE o.status='done' ORDER BY o.id DESC LIMIT 5000`).all();
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '进货明细');
  sendWorkbook(res, wb, '进货明细.xlsx');
});
router.get('/export/sales', (req, res) => {
  const rows = db.prepare(`SELECT o.order_no AS 单号, o.order_date AS 日期, cu.name AS 客户, w.name AS 仓库,
    p.name AS 商品, i.quantity AS 数量, COALESCE(u.name,'') AS 单位, i.unit_price AS 单价, i.amount AS 金额, i.cost_amount AS 成本, o.remark AS 备注
    FROM sales_order_items i JOIN sales_orders o ON o.id=i.order_id JOIN products p ON p.id=i.product_id
    LEFT JOIN customers cu ON cu.id=o.customer_id LEFT JOIN warehouses w ON w.id=o.warehouse_id LEFT JOIN units u ON u.id=i.unit_id
    WHERE o.status='done' ORDER BY o.id DESC LIMIT 5000`).all();
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '出货明细');
  sendWorkbook(res, wb, '出货明细.xlsx');
});
router.get('/export/ledger', (req, res) => {
  const rows = db.prepare(`SELECT l.created_at AS 时间, p.name AS 商品, w.name AS 仓库,
    CASE l.type WHEN 'purchase_in' THEN '采购入库' WHEN 'sale_out' THEN '销售出库' WHEN 'adjustment' THEN '库存调整' ELSE '作废冲销' END AS 类型,
    l.change_qty AS 变动数量, l.unit_price AS 单价, l.amount AS 金额, l.balance AS 结存数量, l.ref_no AS 关联单号, l.remark AS 备注
    FROM stock_ledger l JOIN products p ON p.id=l.product_id LEFT JOIN warehouses w ON w.id=l.warehouse_id
    ORDER BY l.id DESC LIMIT 10000`).all();
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '库存流水');
  sendWorkbook(res, wb, '库存流水.xlsx');
});
router.get('/export/profit', (req, res) => {
  const rows = db.prepare(`SELECT p.name AS 商品, p.category AS 分类,
    ROUND(SUM(i.quantity_base),3) AS 销量, ROUND(SUM(i.amount),2) AS 销售额, ROUND(SUM(i.cost_amount),2) AS 成本, ROUND(SUM(i.amount-i.cost_amount),2) AS 毛利
    FROM sales_order_items i JOIN sales_orders o ON o.id=i.order_id JOIN products p ON p.id=i.product_id
    WHERE o.status='done' GROUP BY p.id ORDER BY 毛利 DESC LIMIT 2000`).all();
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '毛利');
  sendWorkbook(res, wb, '毛利报表.xlsx');
});

export default router;
