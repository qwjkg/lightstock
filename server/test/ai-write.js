import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightstock-ai-write-'));
process.env.LIGHTSTOCK_DATA_DIR = dir;

const { db } = await import('../src/db.js');
const { executeTool, validateAction, toolDefsFor } = await import('../src/ai/tools.js');
const { executeAction } = await import('../src/ai/actions.js');
const {
  createSession, getPermission, markPendingAction, getPendingAction
} = await import('../src/ai/permissions.js');
const { runAgent } = await import('../src/ai/agent.js');

function seed() {
  const unit = db.prepare("SELECT id FROM units WHERE name='件'").get();
  const wh = db.prepare('SELECT id FROM warehouses LIMIT 1').get();
  db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('测试供应商');
  db.prepare('INSERT INTO customers (name) VALUES (?)').run('测试客户');
  const sup = db.prepare('SELECT id FROM suppliers WHERE name=?').get('测试供应商');
  const cus = db.prepare('SELECT id FROM customers WHERE name=?').get('测试客户');
  const p = db.prepare('INSERT INTO products (name, base_unit_id, purchase_price, sale_price) VALUES (?,?,?,?)')
    .run('花椒', unit.id, 10, 20);
  return { unit, wh, sup, cus, pid: Number(p.lastInsertRowid) };
}

function count(table) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}
function stock(pid) {
  return db.prepare('SELECT quantity FROM stock WHERE product_id=?').get(pid)?.quantity || 0;
}
function propose(name, args, session) {
  return executeTool(name, args, { session, permission: getPermission(session) });
}
function confirm(rec, session) {
  const check = validateAction(rec.action);
  assert.equal(check.ok, true, check.error);
  const exec = executeAction(rec, check.resolved);
  markPendingAction(rec.id, 'confirmed');
  return { check, exec };
}

let failed = false;
try {
  const { pid } = seed();
  const session = createSession();
  assert.equal(getPermission(session).level, 'read');
  session.permission = { level: 'write', expires_at: Date.now() + 15 * 60_000 };

  // 1. 进货提案：不写库
  const p1 = propose('propose_purchase_order', {
    supplier: '测试供应商', warehouse: '主仓库',
    items: [{ product: '花椒', quantity: 5, unit: '件', unit_price: 12 }]
  }, session);
  assert.equal(p1.ok, true, p1.error);
  assert.ok(p1.action?.confirm_token);
  assert.equal(p1.action.preview.total_amount, 60);
  assert.equal(p1.action.preview.stock_changes[0].before, 0);
  assert.equal(p1.action.preview.stock_changes[0].after, 5);
  assert.equal(count('purchase_orders'), 0);

  const rec1 = getPendingAction(p1.action.action_id);
  assert.ok(rec1);
  assert.equal(rec1.status, 'proposed');
  const { exec: e1 } = confirm(rec1, session);
  assert.ok(e1.result.order_no);
  assert.equal(count('purchase_orders'), 1);
  assert.equal(stock(pid), 5);
  assert.equal(count('stock_ledger'), 1);

  // 2. 出货提案：库存 5 -> 3
  const p2 = propose('propose_sales_order', {
    customer: '测试客户', warehouse: '主仓库',
    items: [{ product: '花椒', quantity: 2, unit: '件', unit_price: 20 }]
  }, session);
  assert.equal(p2.ok, true, p2.error);
  assert.equal(p2.action.preview.stock_changes[0].before, 5);
  assert.equal(p2.action.preview.stock_changes[0].after, 3);
  confirm(getPendingAction(p2.action.action_id), session);
  assert.equal(stock(pid), 3);
  assert.equal(count('sales_orders'), 1);

  // 3. 库存不足：提案阶段就拒绝
  const p3 = propose('propose_sales_order', {
    customer: '测试客户', warehouse: '主仓库',
    items: [{ product: '花椒', quantity: 100, unit: '件', unit_price: 20 }]
  }, session);
  assert.equal(p3.ok, false);
  assert.equal(p3.code, 'INSUFFICIENT_STOCK');
  assert.equal(count('sales_orders'), 1);

  // 4. 盘点提案：3 -> 6
  const p4 = propose('propose_stock_adjustment', {
    product: '花椒', warehouse: '主仓库', unit: '件', delta_qty: 3, reason: '盘点'
  }, session);
  assert.equal(p4.ok, true, p4.error);
  assert.equal(p4.action.preview.before, 3);
  assert.equal(p4.action.preview.after, 6);
  confirm(getPendingAction(p4.action.action_id), session);
  assert.equal(stock(pid), 6);

  // 5. 只读会话不能提案
  const readSession = createSession();
  const denied = propose('propose_purchase_order', {
    supplier: '测试供应商', warehouse: '主仓库',
    items: [{ product: '花椒', quantity: 1, unit: '件' }]
  }, readSession);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'PERMISSION_DENIED');

  // 6. 工具列表按权限过滤
  const readNames = toolDefsFor('read').map(t => t.function.name);
  const writeNames = toolDefsFor('write').map(t => t.function.name);
  const dangerNames = toolDefsFor('danger').map(t => t.function.name);
  assert.ok(!readNames.some(n => n.startsWith('propose_')));
  assert.ok(writeNames.includes('propose_purchase_order'));
  assert.ok(writeNames.includes('propose_sales_order'));
  assert.ok(writeNames.includes('propose_stock_adjustment'));
  assert.ok(!writeNames.includes('propose_void_order'));
  assert.ok(dangerNames.includes('propose_void_order'));
  assert.ok(dangerNames.includes('propose_update_order'));

  // 6.1 高风险：作废出货单
  const salesNo = db.prepare('SELECT order_no FROM sales_orders LIMIT 1').get().order_no;
  const purchaseNo = db.prepare('SELECT order_no FROM purchase_orders LIMIT 1').get().order_no;
  const dangerSession = createSession();
  dangerSession.permission = { level: 'danger', expires_at: Date.now() + 5 * 60_000 };
  const beforeVoid = stock(pid);
  const v = propose('propose_void_order', { kind: 'sales', order_no: salesNo, reason: '测试作废' }, dangerSession);
  assert.equal(v.ok, true, v.error);
  assert.equal(v.action.preview.stock_changes[0].before, beforeVoid);
  assert.equal(v.action.preview.stock_changes[0].delta, 2);
  confirm(getPendingAction(v.action.action_id), dangerSession);
  assert.equal(db.prepare('SELECT status FROM sales_orders WHERE order_no=?').get(salesNo).status, 'voided');
  assert.equal(stock(pid), beforeVoid + 2);

  // 6.2 高风险：修改进货单
  const beforeUpdate = stock(pid);
  const u = propose('propose_update_order', {
    kind: 'purchase', order_no: purchaseNo,
    items: [{ product: '花椒', unit: '件', quantity: 7, unit_price: 13 }]
  }, dangerSession);
  assert.equal(u.ok, true, u.error);
  assert.equal(u.action.preview.old_total_amount, 60);
  assert.equal(u.action.preview.total_amount, 91);
  assert.equal(u.action.preview.items_changed, true);
  assert.equal(u.action.preview.stock_changes[0].delta, 2);
  confirm(getPendingAction(u.action.action_id), dangerSession);
  const po = db.prepare('SELECT * FROM purchase_orders WHERE order_no=?').get(purchaseNo);
  assert.equal(po.total_amount, 91);
  assert.equal(db.prepare('SELECT quantity FROM purchase_order_items WHERE order_id=?').get(po.id).quantity, 7);
  assert.equal(stock(pid), beforeUpdate + 2);

  // 6.3 write 权限不能做高风险操作
  const writeSession2 = createSession();
  writeSession2.permission = { level: 'write', expires_at: Date.now() + 60_000 };
  const deniedVoid = propose('propose_void_order', { kind: 'sales', order_no: salesNo, reason: 'x' }, writeSession2);
  assert.equal(deniedVoid.ok, false);
  assert.equal(deniedVoid.code, 'PERMISSION_DENIED');

  // 7. 写权限过期
  const expiredSession = createSession();
  expiredSession.permission = { level: 'write', expires_at: Date.now() - 1 };
  assert.equal(getPermission(expiredSession).level, 'read');

  // 8. Agent：模型能看到写工具，但工具结果里不能带 confirm_token
  let calls = 0;
  let toolMessage = '';
  const fakeProvider = async ({ messages }) => {
    calls++;
    if (calls === 1) {
      return {
        message: {
          role: 'assistant', content: '',
          tool_calls: [{
            id: 'call_1', type: 'function',
            function: {
              name: 'propose_purchase_order',
              arguments: JSON.stringify({
                supplier: '测试供应商', warehouse: '主仓库',
                items: [{ product: '花椒', quantity: 1, unit: '件', unit_price: 12 }]
              })
            }
          }]
        },
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: 'fake', duration_ms: 1
      };
    }
    const tm = messages.find(m => m.role === 'tool');
    toolMessage = tm ? tm.content : '';
    return {
      message: { role: 'assistant', content: '已生成待确认的进货单，请在卡片上确认。' },
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      model: 'fake', duration_ms: 1
    };
  };
  const beforeOrders = count('purchase_orders');
  const agentOut = await runAgent({
    session: createSession(),
    messages: [{ role: 'user', content: '帮我进 1 件花椒，单价 12' }],
    provider: fakeProvider
  });
  // runAgent 用传入 session；这里需要写权限，重新跑一次
  const writeSession = createSession();
  writeSession.permission = { level: 'write', expires_at: Date.now() + 60_000 };
  calls = 0;
  const agentOut2 = await runAgent({
    session: writeSession,
    messages: [{ role: 'user', content: '帮我进 1 件花椒，单价 12' }],
    provider: fakeProvider
  });
  assert.equal(agentOut2.actions.length, 1);
  assert.ok(agentOut2.actions[0].confirm_token);
  assert.ok(!toolMessage.includes('confirm_token'));
  assert.equal(count('purchase_orders'), beforeOrders);

  console.log('AI write tests passed.');
} catch (e) {
  failed = true;
  console.error('AI write tests failed:', e);
} finally {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
}
if (failed) process.exit(1);