import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import db.js 之前设置，确保测试只用临时库，
// 不会碰到 server/data/warehouse.db 里的真实账本。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightstock-ai-test-'));
process.env.LIGHTSTOCK_DATA_DIR = dir;

const { db } = await import('../src/db.js');
const { createPurchaseOrder, createSalesOrder, voidOrder } = await import('../src/services/stock.js');
const { executeTool, TOOL_DEFS } = await import('../src/ai/tools.js');
const { runAgent } = await import('../src/ai/agent.js');
const { createSession } = await import('../src/ai/permissions.js');

function seed() {
  const unit = db.prepare("SELECT id FROM units WHERE name='件'").get();
  const kg = db.prepare("SELECT id FROM units WHERE name='公斤'").get();
  const wh = db.prepare('SELECT id FROM warehouses LIMIT 1').get();
  db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('测试供应商');
  db.prepare('INSERT INTO customers (name) VALUES (?)').run('测试客户');
  const sup = db.prepare('SELECT id FROM suppliers WHERE name=?').get('测试供应商');
  const cus = db.prepare('SELECT id FROM customers WHERE name=?').get('测试客户');

  const p = db.prepare('INSERT INTO products (name, base_unit_id, purchase_price, sale_price, stock_low) VALUES (?,?,?,?,?)')
    .run('花椒', unit.id, 10, 20, 15);
  const pid = Number(p.lastInsertRowid);
  createPurchaseOrder({
    supplier_id: sup.id, warehouse_id: wh.id, order_date: '2026-10-01',
    items: [{ product_id: pid, unit_id: unit.id, quantity: 10, unit_price: 10 }]
  });
  createSalesOrder({
    customer_id: cus.id, warehouse_id: wh.id, order_date: '2026-10-02',
    items: [{ product_id: pid, unit_id: unit.id, quantity: 3, unit_price: 20 }]
  });

  // 直接造一个重量基准单位商品，验证不同维度不会被硬加在一起。
  const wp = db.prepare('INSERT INTO products (name, base_unit_id, purchase_price, sale_price, avg_cost) VALUES (?,?,?,?,?)')
    .run('八角', kg.id, 30, 50, 30);
  db.prepare('INSERT INTO stock (product_id, warehouse_id, quantity) VALUES (?,?,?)')
    .run(Number(wp.lastInsertRowid), wh.id, 5);

  return { pid, sup, cus, wh, unit };
}

let failed = false;
try {
  const { pid, wh } = seed();

  const summary = executeTool('stock_summary', {});
  assert.equal(summary.ok, true);
  assert.equal(summary.data.cost_value, 220);
  const countDim = summary.data.by_dimension.find(d => d.dimension === 'count');
  const weightDim = summary.data.by_dimension.find(d => d.dimension === 'weight');
  assert.equal(countDim.qty, 7);
  assert.equal(weightDim.qty, 5);
  assert.ok(summary.notes.some(n => n.includes('不能相加')));
  assert.ok(summary.cards.some(c => c.type === 'metrics'));

  const warehouseSummary = executeTool('stock_summary', { warehouse: wh.id });
  assert.equal(warehouseSummary.data.cost_value, 220);

  const low = executeTool('low_stock', {});
  assert.equal(low.ok, true);
  assert.equal(low.data.rows.length, 1);
  assert.equal(low.data.rows[0].name, '花椒');
  assert.equal(low.data.rows[0].gap, 8);

  const sales = executeTool('sales_report', { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(sales.data.total.amount, 60);
  const profit = executeTool('profit_report', { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(profit.data.total.profit, 30);

  const ledger = executeTool('ledger_query', { product: pid });
  assert.equal(ledger.ok, true);
  assert.equal(ledger.data.rows.length, 2);

  const stockList = executeTool('stock_list', { low_only: true });
  assert.equal(stockList.ok, true);
  assert.equal(stockList.data.rows.length, 1);

  const sold = db.prepare('SELECT id FROM sales_orders LIMIT 1').get();
  const orderList = executeTool('order_list', { kind: 'sales' });
  assert.equal(orderList.ok, true);
  assert.equal(orderList.data.rows.length, 1);
  const orderDetail = executeTool('order_detail', { kind: 'sales', id: sold.id });
  assert.equal(orderDetail.ok, true);
  assert.equal(orderDetail.data.items.length, 1);

  const purchase = executeTool('purchase_report', { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(purchase.data.total.amount, 100);

  const dash = executeTool('dashboard_overview', {});
  assert.equal(dash.ok, true);
  assert.equal(dash.data.stats.productCount, 2);

  const resolved = executeTool('resolve_entity', { type: 'product', query: '花椒' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.data.candidates.length, 1);

  voidOrder('sales', sold.id);
  const profitAfterVoid = executeTool('profit_report', { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(profitAfterVoid.data.total.amount, 0);
  assert.equal(profitAfterVoid.data.total.profit, 0);

  // 只读工具集里不应出现任何写操作。
  const names = TOOL_DEFS.map(t => t.function.name);
  assert.ok(!names.some(n => n.startsWith('propose_')));

  // 用假 provider 跑一遍工具循环：先调 stock_summary，再出最终回答。
  let calls = 0;
  const fakeProvider = async () => {
    calls++;
    if (calls === 1) {
      return {
        message: {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'stock_summary', arguments: '{}' } }]
        },
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: 'fake', duration_ms: 1
      };
    }
    return {
      message: { role: 'assistant', content: '主仓库库存金额 250 元。' },
      usage: { prompt_tokens: 20, completion_tokens: 10 },
      model: 'fake', duration_ms: 1
    };
  };
  const session = createSession();
  const out = await runAgent({
    session,
    messages: [{ role: 'user', content: '主仓库有多少库存？' }],
    provider: fakeProvider
  });
  assert.match(out.reply, /250/);
  assert.equal(out.tool_calls.length, 1);
  assert.ok(out.cards.length >= 1);
  assert.equal(out.usage.prompt_tokens, 30);

  // 数据问题但模型没调工具 → 服务端必须加“未查询数据”警告。
  const ungrounded = await runAgent({
    session: createSession(),
    messages: [{ role: 'user', content: '主仓库有多少库存？' }],
    provider: async () => ({
      message: { role: 'assistant', content: '大概 100 件。' },
      usage: { prompt_tokens: 5, completion_tokens: 5 },
      model: 'fake', duration_ms: 1
    })
  });
  assert.ok(ungrounded.cards.some(c => c.type === 'warning'));
  assert.match(ungrounded.reply, /未查询数据/);

  const audit = db.prepare('SELECT kind, tool_name FROM ai_audit_log ORDER BY id').all();
  assert.ok(audit.some(r => r.kind === 'tool' && r.tool_name === 'stock_summary'));
  assert.ok(audit.some(r => r.kind === 'chat'));

  console.log('AI tests passed.');
} catch (e) {
  failed = true;
  console.error('AI tests failed:', e);
} finally {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows 偶发占用，忽略 */ }
}
if (failed) process.exit(1);