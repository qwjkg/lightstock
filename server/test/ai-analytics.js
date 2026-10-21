import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightstock-ai-analytics-'));
process.env.LIGHTSTOCK_DATA_DIR = dir;

const { db } = await import('../src/db.js');
const { createPurchaseOrder, createSalesOrder, adjustStock } = await import('../src/services/stock.js');
const { executeTool } = await import('../src/ai/tools.js');

function seed() {
  const unit = db.prepare("SELECT id FROM units WHERE name='件'").get();
  const kg = db.prepare("SELECT id FROM units WHERE name='公斤'").get();
  const wh = db.prepare('SELECT id FROM warehouses LIMIT 1').get();
  db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('供应商A');
  db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('供应商B');
  db.prepare('INSERT INTO customers (name) VALUES (?)').run('客户C1');
  db.prepare('INSERT INTO customers (name) VALUES (?)').run('客户C2');
  const spA = db.prepare('SELECT id FROM suppliers WHERE name=?').get('供应商A');
  const spB = db.prepare('SELECT id FROM suppliers WHERE name=?').get('供应商B');
  const c1 = db.prepare('SELECT id FROM customers WHERE name=?').get('客户C1');
  const c2 = db.prepare('SELECT id FROM customers WHERE name=?').get('客户C2');

  const huajiao = db.prepare('INSERT INTO products (name, base_unit_id, purchase_price, sale_price, stock_low) VALUES (?,?,?,?,?)')
    .run('花椒', unit.id, 10, 20, 10);
  const bajiao = db.prepare('INSERT INTO products (name, base_unit_id, purchase_price, sale_price, stock_low) VALUES (?,?,?,?,?)')
    .run('八角', kg.id, 30, 50, 10);
  const guipi = db.prepare('INSERT INTO products (name, base_unit_id, purchase_price, sale_price, stock_low) VALUES (?,?,?,?,?)')
    .run('桂皮', unit.id, 5, 12, 10);
  const zero = db.prepare('INSERT INTO products (name, base_unit_id, purchase_price, sale_price, stock_low, avg_cost) VALUES (?,?,?,?,?,?)')
    .run('零成本商品', unit.id, 0, 0, 10, 0);
  const neg = db.prepare('INSERT INTO products (name, base_unit_id, purchase_price, sale_price, stock_low, avg_cost) VALUES (?,?,?,?,?,?)')
    .run('负库存商品', unit.id, 0, 0, 10, 0);
  const hp = Number(huajiao.lastInsertRowid);
  const bp = Number(bajiao.lastInsertRowid);
  const gp = Number(guipi.lastInsertRowid);
  const zp = Number(zero.lastInsertRowid);
  const np = Number(neg.lastInsertRowid);

  createPurchaseOrder({ supplier_id: spA.id, warehouse_id: wh.id, order_date: '2026-09-01', items: [{ product_id: hp, unit_id: unit.id, quantity: 10, unit_price: 10 }] });
  createPurchaseOrder({ supplier_id: spB.id, warehouse_id: wh.id, order_date: '2026-10-01', items: [{ product_id: hp, unit_id: unit.id, quantity: 10, unit_price: 12 }] });
  createPurchaseOrder({ supplier_id: spA.id, warehouse_id: wh.id, order_date: '2026-10-02', items: [{ product_id: bp, unit_id: kg.id, quantity: 10, unit_price: 30 }] });
  createPurchaseOrder({ supplier_id: spA.id, warehouse_id: wh.id, order_date: '2026-10-06', items: [{ product_id: gp, unit_id: unit.id, quantity: 5, unit_price: 5 }] });
  createSalesOrder({ customer_id: c1.id, warehouse_id: wh.id, order_date: '2026-10-03', items: [{ product_id: hp, unit_id: unit.id, quantity: 5, unit_price: 20 }] });
  createSalesOrder({ customer_id: c2.id, warehouse_id: wh.id, order_date: '2026-10-04', items: [{ product_id: hp, unit_id: unit.id, quantity: 2, unit_price: 22 }] });
  createSalesOrder({ customer_id: c1.id, warehouse_id: wh.id, order_date: '2026-10-05', items: [{ product_id: bp, unit_id: kg.id, quantity: 3, unit_price: 50 }] });
  adjustStock({ product_id: hp, warehouse_id: wh.id, unit_id: unit.id, delta_qty: -15, remark: '测试负库存' });

  db.prepare('INSERT INTO stock (product_id, warehouse_id, quantity) VALUES (?,?,?)').run(zp, wh.id, 5);
  db.prepare('INSERT INTO stock (product_id, warehouse_id, quantity) VALUES (?,?,?)').run(np, wh.id, -2);
  return { unit, kg, wh, spA, spB, c1, c2, hp, bp, gp, zp, np };
}

let failed = false;
try {
  const d = seed();

  const health = executeTool('inventory_health', { slow_days: 60 });
  assert.equal(health.ok, true, health.error);
  assert.ok(health.data.summary.slow_moving_count >= 2);
  assert.ok(health.data.summary.negative_count >= 2);
  assert.ok(health.data.summary.zero_cost_count >= 1);
  assert.ok(health.data.summary.zero_sale_count >= 1);
  assert.ok(health.data.summary.low_stock_count >= 4);
  assert.ok(health.data.slow_moving.some(r => r.name === '桂皮'));

  const price = executeTool('price_history', { product: '花椒' });
  assert.equal(price.ok, true, price.error);
  assert.equal(price.data.rows.length, 2);
  assert.equal(price.data.summary.latest, 12);
  assert.equal(price.data.summary.min, 10);
  assert.equal(price.data.summary.max, 12);
  assert.equal(price.data.summary.change_pct, 20);

  const movement = executeTool('product_movement', { product: '花椒', from: '2026-09-01', to: '2026-10-31' });
  assert.equal(movement.ok, true, movement.error);
  assert.equal(movement.data.opening, 0);
  assert.equal(movement.data.by_type.find(r => r.type === 'purchase_in').qty, 20);
  assert.equal(movement.data.by_type.find(r => r.type === 'sale_out').qty, -7);
  assert.equal(movement.data.by_type.find(r => r.type === 'adjustment').qty, -15);
  assert.equal(movement.data.closing, -2);
  assert.equal(movement.data.current_stock, -2);

  const suppliers = executeTool('partner_ranking', { kind: 'supplier' });
  assert.equal(suppliers.ok, true, suppliers.error);
  assert.equal(suppliers.data.rows[0].name, '供应商A');
  assert.equal(suppliers.data.rows[0].amount, 425);
  const customers = executeTool('partner_ranking', { kind: 'customer' });
  assert.equal(customers.data.rows[0].name, '客户C1');
  assert.equal(customers.data.rows[0].amount, 250);

  const salesTrend = executeTool('business_trend', { kind: 'sales', group_by: 'day', from: '2026-10-01', to: '2026-10-31' });
  assert.equal(salesTrend.ok, true, salesTrend.error);
  assert.equal(salesTrend.data.rows.length, 3);
  assert.equal(salesTrend.data.total.amount, 294);
  assert.equal(salesTrend.data.total.cost, 167);
  assert.equal(salesTrend.data.total.profit, 127);
  const monthTrend = executeTool('business_trend', { kind: 'sales', group_by: 'month', from: '2026-10-01', to: '2026-10-31' });
  assert.equal(monthTrend.data.rows.length, 1);
  assert.equal(monthTrend.data.rows[0].bucket, '2026-10');

  const purchaseTrend = executeTool('business_trend', { kind: 'purchase', group_by: 'day', from: '2026-09-01', to: '2026-10-31' });
  assert.equal(purchaseTrend.data.total.amount, 545);

  console.log('AI analytics tests passed.');
} catch (e) {
  failed = true;
  console.error('AI analytics tests failed:', e);
} finally {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
}
if (failed) process.exit(1);