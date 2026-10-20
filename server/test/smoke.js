// 冒烟测试：启动服务器进程后执行核心进销存流程验证
// 用法：先启动 server（npm start），再运行 node test/smoke.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 不要用 3000：那是正式服务的端口，测试会连到正在运行的真实库上。
const PORT = Number(process.env.SMOKE_PORT || 3100);
const BASE = `http://localhost:${PORT}`;
const PASS = { ok: [], fail: [] };

function check(name, cond, extra = '') {
  if (cond) { PASS.ok.push(name); console.log(`  ✔ ${name}`); }
  else { PASS.fail.push(name); console.log(`  ✘ ${name} ${extra}`); }
}

async function api(method, url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch { }
  return { status: r.status, data };
}

// 安全保护：该测试会删除数据库文件，默认拒绝在已有真实数据的目录运行
const dataDir = process.env.LIGHTSTOCK_DATA_DIR
  ? path.resolve(process.env.LIGHTSTOCK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const dbFile = path.join(dataDir, 'warehouse.db');
if (fs.existsSync(dbFile) && !process.env.SMOKE_ALLOW_DELETE) {
  console.error('[安全保护] 检测到已有数据库 ' + dbFile + '。');
  console.error('本测试会删除该文件，为避免误清空真实数据，请：');
  console.error('  1) 将代码复制到隔离目录运行，或');
  console.error('  2) 确认数据已备份后设置环境变量 SMOKE_ALLOW_DELETE=1 再运行。');
  process.exit(2);
}

// 端口必须是空的。否则本测试会连到「已经跑着的另一个服务」上，
// 把测试数据写进那个服务的库——正式服务恰好就在 3000。
async function portAlreadyServing() {
  try {
    await fetch(`${BASE}/api/units`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch { return false; }
}
if (await portAlreadyServing()) {
  console.error(`[安全保护] 端口 ${PORT} 上已经有服务在运行。`);
  console.error('本测试会写入并删除数据，请先停掉那个服务，或用 SMOKE_PORT 指定其他端口。');
  process.exit(3);
}

for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

let serverExited = false;
const server = spawn(process.execPath, ['src/index.js'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), LIGHTSTOCK_DATA_DIR: dataDir }
});
server.on('exit', () => { serverExited = true; });

const waitReady = async () => {
  for (let i = 0; i < 60; i++) {
    if (serverExited) return false;   // 没起来（多半是端口被占），不要再往下测
    try {
      const r = await fetch(BASE + '/api/units');
      if (r.ok || r.status === 401) return true;
    } catch { }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
};

try {
  console.log('=== 轻进销存 冒烟测试 ===');
  const ready = await waitReady();
  check('服务启动', ready);
  if (!ready) throw new Error(`服务未能启动（端口 ${PORT} 可能被占用）`);

  // 基础资料
  const wh = await api('GET', '/api/warehouses');
  check('默认仓库存在', wh.data.length >= 1, JSON.stringify(wh.data));
  const whId = wh.data[0].id;

  const unitResp = await api('GET', '/api/units');
  const jian = unitResp.data.find(u => u.name === '件');
  const xiang = unitResp.data.find(u => u.name === '箱');
  check('默认单位(件/箱)存在', !!(jian && xiang));

  const sup = await api('POST', '/api/suppliers', { name: '测试供应商', phone: '13800000000' });
  check('新增供应商', sup.status === 200 && sup.data.id > 0, JSON.stringify(sup.data));
  const cus = await api('POST', '/api/customers', { name: '测试客户' });
  check('新增客户', cus.status === 200 && cus.data.id > 0);

  const prod = await api('POST', '/api/products', {
    name: '矿泉水', category: '饮品', base_unit_id: jian.id,
    weight_per_base_kg: 0.5, purchase_price: 1, sale_price: 1.5, stock_low: 10
  });
  const prodId = prod.data.id;
  check('新增商品', prod.status === 200 && prodId > 0);

  // 采购入库：5箱 = 120件
  const po = await api('POST', '/api/purchase-orders', {
    supplier_id: sup.data.id, warehouse_id: whId, order_date: new Date().toISOString().slice(0, 10),
    items: [{ product_id: prodId, unit_id: xiang.id, quantity: 5, unit_price: 22 }]
  });
  check('采购入库(5箱=120件)', po.status === 200 && po.data.total_amount === 110, JSON.stringify(po.data));
  const poNo = po.data.order_no;

  let stock = await api('GET', '/api/stock');
  const s1 = stock.data.find(s => s.product_id === prodId);
  check('库存=120件', s1 && s1.quantity === 120, JSON.stringify(s1));
  check('库存金额=110', s1 && s1.stock_value === 110);
  check('重量=60kg', s1 && s1.weight_kg === 60);

  const prodAfter = await api('GET', '/api/products');
  const pa = prodAfter.data.find(p => p.id === prodId);
  check('平均成本=0.9167', pa && Math.abs(pa.avg_cost - 110 / 120) < 0.001, JSON.stringify(pa));

  // 销售出库：30件
  const so = await api('POST', '/api/sales-orders', {
    customer_id: cus.data.id, warehouse_id: whId,
    items: [{ product_id: prodId, unit_id: jian.id, quantity: 30, unit_price: 1.5 }]
  });
  check('销售出库(30件)', so.status === 200 && so.data.total_amount === 45, JSON.stringify(so.data));

  stock = await api('GET', '/api/stock');
  const s2 = stock.data.find(s => s.product_id === prodId);
  check('库存=90件', s2 && s2.quantity === 90, JSON.stringify(s2));

  // 毛利
  const profit = await api('GET', '/api/reports/profit');
  check('毛利=45-27.5=17.5', profit.data.total.profit === 17.5, JSON.stringify(profit.data.total));

  // 低库存预警（90 > 10 不触发）
  const low = await api('GET', '/api/stock/low');
  check('低库存不误报', !low.data.find(p => p.id === prodId), JSON.stringify(low.data));

  // 作废销售单 → 库存回到120
  const voidSo = await api('POST', `/api/sales-orders/${so.data.id}/void`);
  check('作废销售单', voidSo.status === 200);
  stock = await api('GET', '/api/stock');
  const s3 = stock.data.find(s => s.product_id === prodId);
  check('作废后库存=120', s3 && s3.quantity === 120, JSON.stringify(s3));

  // 作废采购单 → 库存归零
  await api('POST', `/api/purchase-orders/${po.data.id}/void`);
  stock = await api('GET', '/api/stock');
  check('作废采购后库存=0', !stock.data.find(s => s.product_id === prodId));

  // 库存调整
  const adj = await api('POST', '/api/stock/adjust', { product_id: prodId, warehouse_id: whId, unit_id: jian.id, delta_qty: 50, remark: '盘点调整' });
  check('库存调整+50', adj.status === 200);
  stock = await api('GET', '/api/stock');
  const s4 = stock.data.find(s => s.product_id === prodId);
  check('调整后库存=50', s4 && s4.quantity === 50);

  // 流水
  const ledger = await api('GET', '/api/ledger');
  check('流水记录>=5条', ledger.data.length >= 5, `count=${ledger.data.length}`);

  // 报表
  const pr = await api('GET', '/api/reports/purchase');
  check('进货报表接口', pr.status === 200);

  // 备份
  const bk = await api('POST', '/api/backups');
  check('手动备份', bk.status === 200 && bk.data.list.length >= 1);

  // 自定义字段
  const cf = await api('POST', '/api/custom-fields', { entity: 'product', name: 'origin', label: '产地', field_type: 'text' });
  check('新增自定义字段', cf.status === 200 && cf.data.id > 0);
  const cfList = await api('GET', '/api/custom-fields?entity=product');
  check('自定义字段列表', cfList.data.length >= 1);

  // 仪表盘
  const dash = await api('GET', '/api/reports/dashboard');
  check('仪表盘接口', dash.status === 200 && dash.data.trend.length === 30);

  // 访问密码鉴权
  await api('PUT', '/api/settings', { access_password: '123456' });
  const noAuth = await api('GET', '/api/units');
  check('未带 token 返回 401', noAuth.status === 401);
  const badLogin = await api('POST', '/api/login', { password: 'wrong' });
  check('错误密码拒绝', badLogin.status === 401);
  const login = await api('POST', '/api/login', { password: '123456' });
  check('正确密码登录', login.status === 200 && !!login.data.token);
  const authed = await api('GET', '/api/units', null, login.data.token);
  check('带 token 访问成功', authed.status === 200 && authed.data.length > 0);
  await api('PUT', '/api/settings', { access_password: '' }, login.data.token);
  const noPw = await api('GET', '/api/units');
  check('清除密码后免登录', noPw.status === 200);
  console.log('');
  console.log(`结果: ${PASS.ok.length} 通过, ${PASS.fail.length} 失败`);
} catch (e) {
  console.error('测试异常:', e.message);
  PASS.fail.push('异常:' + e.message);
} finally {
  server.kill();
  process.exit(PASS.fail.length ? 1 : 0);
}

