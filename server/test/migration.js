// 一次性成本迁移的验证脚本（在隔离库中运行）
// 构造一个「旧算法记错了成本」的账本，跑 migrateCostV2，验证是否修正。
// 用法：node test/migration.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });

const RESULT = { ok: [], fail: [] };
function check(name, cond, extra = '') {
  if (cond) { RESULT.ok.push(name); console.log(`  ✔ ${name}`); }
  else { RESULT.fail.push(name); console.log(`  ✘ ${name} ${extra}`); }
}

const { db, getSetting } = await import('../src/db.js');
const { migrateCostV2 } = await import('../src/migrate.js');

// ---------- 构造旧算法的账 ----------
// 花椒：进 100@10 → 卖 50 → 进 100@20 → 卖 50
// 旧算法在第二笔卖货时用「全部采购金额/全部采购数量」= 3000/200 = 15 结转，
// 正确应为移动加权平均 (50×10 + 100×20)/150 = 16.6667
const unitId = db.prepare("SELECT id FROM units WHERE name='件'").get().id;
const whId = db.prepare('SELECT id FROM warehouses LIMIT 1').get().id;
const supId = db.prepare("INSERT INTO suppliers (name) VALUES ('香料批发商')").run().lastInsertRowid;
const cusId = db.prepare("INSERT INTO customers (name) VALUES ('卤味店')").run().lastInsertRowid;
const pid = db.prepare(`INSERT INTO products (name, base_unit_id, purchase_price, sale_price, avg_cost)
  VALUES ('花椒',?,10,20,15)`).run(unitId).lastInsertRowid;

const insLedger = db.prepare(`INSERT INTO stock_ledger
  (product_id, warehouse_id, type, change_qty, change_qty_original, unit_id, unit_price, amount, cost_amount, balance, ref_type, ref_id, ref_no)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const setStock = db.prepare(`INSERT INTO stock (product_id, warehouse_id, quantity) VALUES (?,?,?)
  ON CONFLICT(product_id, warehouse_id) DO UPDATE SET quantity=excluded.quantity`);

// 进 100 @10
let o1 = db.prepare(`INSERT INTO purchase_orders (order_no, supplier_id, warehouse_id, order_date, total_amount)
  VALUES ('CG-OLD-1',?,?,date('now'),1000)`).run(supId, whId).lastInsertRowid;
db.prepare(`INSERT INTO purchase_order_items (order_id, product_id, unit_id, quantity, quantity_base, unit_price, amount)
  VALUES (?,?,?,100,100,10,1000)`).run(o1, pid, unitId);
insLedger.run(pid, whId, 'purchase_in', 100, 100, unitId, 10, 1000, 1000, 100, 'purchase_order', o1, 'CG-OLD-1');
setStock.run(pid, whId, 100);

// 卖 50（旧均价 10 → 成本 500，这个值是对的）
let s1 = db.prepare(`INSERT INTO sales_orders (order_no, customer_id, warehouse_id, order_date, total_amount)
  VALUES ('XS-OLD-1',?,?,date('now'),750)`).run(cusId, whId).lastInsertRowid;
db.prepare(`INSERT INTO sales_order_items (order_id, product_id, unit_id, quantity, quantity_base, unit_price, amount, cost_amount)
  VALUES (?,?,?,50,50,15,750,500)`).run(s1, pid, unitId);
insLedger.run(pid, whId, 'sale_out', -50, -50, unitId, 15, 750, 500, 50, 'sales_order', s1, 'XS-OLD-1');
setStock.run(pid, whId, 50);

// 进 100 @20
let o2 = db.prepare(`INSERT INTO purchase_orders (order_no, supplier_id, warehouse_id, order_date, total_amount)
  VALUES ('CG-OLD-2',?,?,date('now'),2000)`).run(supId, whId).lastInsertRowid;
db.prepare(`INSERT INTO purchase_order_items (order_id, product_id, unit_id, quantity, quantity_base, unit_price, amount)
  VALUES (?,?,?,100,100,20,2000)`).run(o2, pid, unitId);
insLedger.run(pid, whId, 'purchase_in', 100, 100, unitId, 20, 2000, 2000, 150, 'purchase_order', o2, 'CG-OLD-2');
setStock.run(pid, whId, 150);

// 卖 50（旧算法此时均价 15 → 成本 750，这就是记错的那一笔）
let s2 = db.prepare(`INSERT INTO sales_orders (order_no, customer_id, warehouse_id, order_date, total_amount)
  VALUES ('XS-OLD-2',?,?,date('now'),1500)`).run(cusId, whId).lastInsertRowid;
db.prepare(`INSERT INTO sales_order_items (order_id, product_id, unit_id, quantity, quantity_base, unit_price, amount, cost_amount)
  VALUES (?,?,?,50,50,30,1500,750)`).run(s2, pid, unitId);
insLedger.run(pid, whId, 'sale_out', -50, -50, unitId, 30, 1500, 750, 100, 'sales_order', s2, 'XS-OLD-2');
setStock.run(pid, whId, 100);

console.log('=== 迁移前（旧算法留下的状态）===');
const before = db.prepare(`SELECT cost_amount FROM stock_ledger WHERE product_id=? AND type='sale_out' ORDER BY id`).all(pid);
console.log('  商品均价:', db.prepare('SELECT avg_cost FROM products WHERE id=?').get(pid).avg_cost);
console.log('  流水结转成本:', before.map(r => r.cost_amount).join(', '));
check('迁移前确实带着旧算法的错值 (15 / 750)', before[1].cost_amount === 750);
check('迁移标志位初始为空', getSetting('cost_algo_v2', '') === '');

console.log('');
console.log('=== 执行迁移 ===');
const stat = await migrateCostV2();
console.log('  迁移统计:', JSON.stringify(stat));

const CORRECT = 2500 / 150; // 16.6667

console.log('');
console.log('=== 迁移后 ===');
const avg = db.prepare('SELECT avg_cost FROM products WHERE id=?').get(pid).avg_cost;
const led = db.prepare(`SELECT cost_amount FROM stock_ledger WHERE product_id=? AND type='sale_out' ORDER BY id`).all(pid);
const items = db.prepare(`SELECT cost_amount FROM sales_order_items WHERE product_id=? ORDER BY id`).all(pid);
console.log('  商品均价:', avg, '（正确值', CORRECT.toFixed(6), '）');
console.log('  流水结转成本:', led.map(r => r.cost_amount).join(', '));
console.log('  销售明细成本:', items.map(r => r.cost_amount).join(', '));
console.log('');

check('迁移后均价修正为 16.6667', Math.abs(avg - CORRECT) < 1e-6, `实际 ${avg}`);
check('第一笔出库成本保持 500（本来就是对的）', Math.abs(led[0].cost_amount - 500) < 1e-6, `实际 ${led[0].cost_amount}`);
check('第二笔出库成本由 750 修正为 833.33', Math.abs(led[1].cost_amount - CORRECT * 50) < 1e-6, `实际 ${led[1].cost_amount}`);
check('销售明细成本同步修正（毛利报表用的就是它）',
  Math.abs(items[0].cost_amount - 500) < 1e-6 && Math.abs(items[1].cost_amount - CORRECT * 50) < 1e-6,
  JSON.stringify(items.map(r => r.cost_amount)));
check('流水与明细成本一致', led.every((r, i) => Math.abs(r.cost_amount - items[i].cost_amount) < 1e-6));
check('迁移标志位已置位', getSetting('cost_algo_v2', '') === '1');

// 迁移前应已自动备份
const backups = fs.readdirSync(path.join(dataDir, 'backups')).filter(f => f.endsWith('.db'));
check('迁移前已自动备份，可回滚', backups.length >= 1, JSON.stringify(backups));

// 幂等性
console.log('');
console.log('=== 重复执行迁移（应当直接跳过）===');
const again = await migrateCostV2();
check('重复执行直接跳过，不重复改写', again === null, `实际返回 ${JSON.stringify(again)}`);
const avgAgain = db.prepare('SELECT avg_cost FROM products WHERE id=?').get(pid).avg_cost;
check('重复执行后均价不变', Math.abs(avgAgain - CORRECT) < 1e-6, `实际 ${avgAgain}`);

console.log('');
console.log(`结果: ${RESULT.ok.length} 通过, ${RESULT.fail.length} 失败`);
process.exit(RESULT.fail.length ? 1 : 0);