import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockPort = 3421;
const appPort = 3422;
let lastToolContent = '';

// 最小 OpenAI 兼容 mock：最后一条是 tool 就回最终答案，否则要求调用 propose。
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
        id: 'mock-2', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: '已生成待确认的进货单，请在卡片上确认。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 8 }
      }));
      return;
    }
    res.end(JSON.stringify({
      id: 'mock-1', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'mock',
      choices: [{
        index: 0,
        message: {
          role: 'assistant', content: null,
          tool_calls: [{
            id: 'call_1', type: 'function',
            function: {
              name: 'propose_purchase_order',
              arguments: JSON.stringify({
                supplier: '测试供应商',
                warehouse: '主仓库',
                items: [{ product: '花椒', quantity: 5, unit: '件', unit_price: 12 }]
              })
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightstock-ai-http-'));
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
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
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

  // 准备基础资料
  const units = await call('GET', '/api/units');
  const unit = units.data.find(u => u.name === '件');
  assert.ok(unit);
  const suppliers = await call('POST', '/api/suppliers', { name: '测试供应商' });
  const customers = await call('POST', '/api/customers', { name: '测试客户' });
  const products = await call('POST', '/api/products', {
    name: '花椒', base_unit_id: unit.id, purchase_price: 10, sale_price: 20
  });
  assert.ok(suppliers.data.id && customers.data.id && products.data.id);

  // 1. 创建会话、授权写
  const session = await call('POST', '/api/ai/session');
  assert.equal(session.data.permission.level, 'read');
  const grant = await call('POST', '/api/ai/permission', {
    session_id: session.data.session_id, level: 'write', minutes: 15
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.data));
  assert.equal(grant.data.permission.level, 'write');

  // 1.1 高风险权限必须先设置访问密码
  const dangerNoPw = await call('POST', '/api/ai/permission', {
    session_id: session.data.session_id, level: 'danger', confirm_text: '确认高风险'
  });
  assert.equal(dangerNoPw.status, 403);
  assert.equal(dangerNoPw.data.code, 'PASSWORD_REQUIRED');

  // 2. 对话：mock 要求提案，服务端返回 action + token
  const chat = await call('POST', '/api/ai/chat', {
    session_id: session.data.session_id,
    messages: [{ role: 'user', content: '帮我进 5 件花椒，单价 12' }]
  });
  assert.equal(chat.status, 200, JSON.stringify(chat.data));
  assert.equal(chat.data.actions.length, 1);
  const action = chat.data.actions[0];
  assert.ok(action.action_id && action.confirm_token);
  assert.equal(action.preview.total_amount, 60);
  assert.ok(!lastToolContent.includes('confirm_token'), '模型上下文不应包含 confirm_token');

  // 3. 确认前没有写库
  let orders = await call('GET', '/api/purchase-orders');
  assert.equal(orders.data.length, 0);

  // 4. 确认执行
  const confirmed = await call('POST', `/api/ai/actions/${action.action_id}/confirm`, {
    session_id: session.data.session_id,
    confirm_token: action.confirm_token
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.ok(confirmed.data.result.order_no);
  assert.ok(confirmed.data.backup, '应自动备份');

  orders = await call('GET', '/api/purchase-orders');
  assert.equal(orders.data.length, 1);
  const detail = await call('GET', `/api/purchase-orders/${orders.data[0].id}`);
  assert.equal(detail.data.items[0].quantity, 5);
  const stock = await call('GET', `/api/stock?productId=${products.data.id}`);
  assert.equal(stock.data[0].quantity, 5);

  // 5. 重复确认应被拒绝
  const again = await call('POST', `/api/ai/actions/${action.action_id}/confirm`, {
    session_id: session.data.session_id,
    confirm_token: action.confirm_token
  });
  assert.equal(again.status, 410);

  // 6. 取消：生成第二个提案后取消，不写库
  const chat2 = await call('POST', '/api/ai/chat', {
    session_id: session.data.session_id,
    messages: [{ role: 'user', content: '再进 1 件花椒，单价 12' }]
  });
  assert.equal(chat2.data.actions.length, 1);
  const action2 = chat2.data.actions[0];
  const cancelled = await call('POST', `/api/ai/actions/${action2.action_id}/cancel`, {
    session_id: session.data.session_id,
    confirm_token: action2.confirm_token
  });
  assert.equal(cancelled.status, 200);
  orders = await call('GET', '/api/purchase-orders');
  assert.equal(orders.data.length, 1);

  // 7. 只读会话：模型即使要求提案，服务端也不应生成 action
  const readSession = await call('POST', '/api/ai/session');
  const readChat = await call('POST', '/api/ai/chat', {
    session_id: readSession.data.session_id,
    messages: [{ role: 'user', content: '帮我进 1 件花椒' }]
  });
  assert.equal(readChat.status, 200);
  assert.equal(readChat.data.actions.length, 0);
  orders = await call('GET', '/api/purchase-orders');
  assert.equal(orders.data.length, 1);

  // 8. 审计里有提案、确认、取消、失败/拒绝
  const audit = await call('GET', '/api/ai/audit?limit=50');
  const actions = audit.data.filter(r => r.kind === 'action');
  assert.ok(actions.some(r => r.action_status === 'proposed'));
  assert.ok(actions.some(r => r.action_status === 'confirmed'));
  assert.ok(actions.some(r => r.action_status === 'cancelled'));

  console.log('AI HTTP write tests passed.');
} catch (e) {
  failed = true;
  console.error('AI HTTP write tests failed:', e);
  console.error('server log:\n' + log);
} finally {
  child.kill();
  mock.close();
  await new Promise(r => setTimeout(r, 400));
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
}
if (failed) process.exit(1);