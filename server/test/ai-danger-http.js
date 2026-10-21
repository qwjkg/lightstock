import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockPort = 3431;
const appPort = 3432;
let orderNo = '';
let lastToolContent = '';

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* ignore */ }
    const messages = parsed.messages || [];
    const last = messages[messages.length - 1];
    res.setHeader('Content-Type', 'application/json');
    if (last?.role === 'tool') {
      lastToolContent = last.content || '';
      res.end(JSON.stringify({
        id: 'mock-2', object: 'chat.completion', created: 0, model: 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: '已生成待确认的作废提案，请在卡片上确认。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 8 }
      }));
      return;
    }
    res.end(JSON.stringify({
      id: 'mock-1', object: 'chat.completion', created: 0, model: 'mock',
      choices: [{
        index: 0,
        message: {
          role: 'assistant', content: null,
          tool_calls: [{
            id: 'call_1', type: 'function',
            function: {
              name: 'propose_void_order',
              arguments: JSON.stringify({ kind: 'purchase', order_no: orderNo, reason: '测试作废' })
            }
          }]
        },
        finish_reason: 'tool_calls'
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10 }
    }));
  });
});
await new Promise(resolve => mock.listen(mockPort, '127.0.0.1', resolve));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightstock-ai-danger-'));
const child = spawn(process.execPath, ['src/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    LIGHTSTOCK_DATA_DIR: dir,
    PORT: String(appPort),
    AI_API_KEY: 'fake',
    AI_BASE_URL: `http://127.0.0.1:${mockPort}`,
    AI_MODEL: 'mock'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
child.stdout.on('data', d => { log += d.toString(); });
child.stderr.on('data', d => { log += d.toString(); });

const base = `http://127.0.0.1:${appPort}`;
let token = '';
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/ai/status`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server not ready: ' + log);
}
async function call(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

let failed = false;
try {
  await waitReady();

  // 设置访问密码，然后登录拿 token（高风险授权必须先有密码）
  const setPw = await call('PUT', '/api/settings', { access_password: 'testpass' });
  assert.equal(setPw.status, 200);
  const login = await call('POST', '/api/login', { password: 'testpass' });
  assert.equal(login.status, 200);
  token = login.data.token;
  assert.ok(token);

  // 准备一张进货单
  const units = await call('GET', '/api/units');
  const unit = units.data.find(u => u.name === '件');
  const whs = await call('GET', '/api/warehouses');
  const wh = whs.data[0];
  const sup = await call('POST', '/api/suppliers', { name: '高风险测试供应商' });
  const prod = await call('POST', '/api/products', { name: '高风险测试花椒', base_unit_id: unit.id, purchase_price: 10, sale_price: 20 });
  const po = await call('POST', '/api/purchase-orders', {
    supplier_id: sup.data.id, warehouse_id: wh.id, order_date: '2026-10-01',
    items: [{ product_id: prod.data.id, unit_id: unit.id, quantity: 5, unit_price: 10 }]
  });
  assert.equal(po.status, 200, JSON.stringify(po.data));
  orderNo = po.data.order_no;
  assert.ok(orderNo);

  // 创建 AI 会话并授权高风险
  const session = await call('POST', '/api/ai/session');
  assert.equal(session.data.permission.level, 'read');
  const grant = await call('POST', '/api/ai/permission', {
    session_id: session.data.session_id, level: 'danger', password: 'testpass', confirm_text: '确认高风险'
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.data));
  assert.equal(grant.data.permission.level, 'danger');

  // 对话：mock 要求作废提案
  const chat = await call('POST', '/api/ai/chat', {
    session_id: session.data.session_id,
    messages: [{ role: 'user', content: '把刚才那张进货单作废' }]
  });
  assert.equal(chat.status, 200, JSON.stringify(chat.data));
  assert.equal(chat.data.actions.length, 1);
  const action = chat.data.actions[0];
  assert.equal(action.type, 'void_order');
  assert.equal(action.preview.order_no, orderNo);
  assert.ok(action.preview.stock_changes[0].delta < 0);
  assert.ok(!lastToolContent.includes('confirm_token'));

  // 确认作废
  const confirmed = await call('POST', `/api/ai/actions/${action.action_id}/confirm`, {
    session_id: session.data.session_id, confirm_token: action.confirm_token
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.ok(confirmed.data.backup);

  const orders = await call('GET', '/api/purchase-orders');
  const target = orders.data.find(o => o.order_no === orderNo);
  assert.equal(target.status, 'voided');
  const stock = await call('GET', `/api/stock?productId=${prod.data.id}`);
  const qty = stock.data.find(r => r.product_id === prod.data.id)?.quantity || 0;
  assert.equal(qty, 0);

  // 审计
  const audit = await call('GET', '/api/ai/audit?limit=50');
  assert.ok(audit.data.some(r => r.kind === 'action' && r.action_status === 'confirmed' && r.ref_no === orderNo));

  console.log('AI danger HTTP tests passed.');
} catch (e) {
  failed = true;
  console.error('AI danger HTTP tests failed:', e);
  console.error('server log:\n' + log);
} finally {
  child.kill();
  mock.close();
  await new Promise(r => setTimeout(r, 400));
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
}
if (failed) process.exit(1);