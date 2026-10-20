// 综合 API 测试：覆盖基础资料、单据、库存、报表、导出、备份、鉴权
// 用法：node test/all.js（会启动一个独立服务进程，端口默认 3200，可用 TEST_PORT 覆盖）
// 注意：请勿在含真实数据的目录直接运行本脚本；建议在隔离副本中运行。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3200);
const BASE = `http://localhost:${PORT}`;
const RESULT = { ok: [], fail: [] };

function check(name, cond, extra = '') {
  if (cond) { RESULT.ok.push(name); console.log(`  ✔ ${name}`); }
  else { RESULT.fail.push(name); console.log(`  ✘ ${name} ${extra}`); }
}

// 进销存的基本恒等式：某商品在某仓库的当前库存，
// 必须等于它全部流水变动量之和。旧实现会在库存将要变负时把行删掉，
// 这条等式就会破——它是「账实不符」最直接的探测器。
async function checkStockEqualsLedger(prodId, whId, label) {
  const st = await api('GET', `/api/stock?productId=${prodId}&warehouseId=${whId}`);
  const led = await api('GET', `/api/ledger?productId=${prodId}&warehouseId=${whId}`);
  const qty = st.data.length ? st.data[0].quantity : 0;
  const sum = Math.round(led.data.reduce((s, r) => s + r.change_qty, 0) * 1e6) / 1e6;
  check(`${label}：库存=流水累计 (${qty})`, Math.abs(qty - sum) < 1e-6, `stock=${qty}, ledger累计=${sum}`);
}

async function api(method, url, body, token, raw = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (raw) {
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, buf };
  }
  let data = null;
  try { data = await r.json(); } catch { }
  return { status: r.status, data };
}

const server = spawn(process.execPath, ['src/index.js'], {
  cwd: serverDir,
  stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), LIGHTSTOCK_DATA_DIR: path.join(serverDir, 'data') }
});

// 端口必须是空的：否则测试会连到「已经跑着的另一个服务」上，
// 把测试数据写进那个服务的库。
async function portAlreadyServing() {
  try {
    await fetch(`${BASE}/api/units`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch { return false; }
}
if (await portAlreadyServing()) {
  console.error(`[安全保护] 端口 ${PORT} 上已经有服务在运行，请先停掉它或用 TEST_PORT 指定其他端口。`);
  process.exit(3);
}

let serverExited = false;
server.on('exit', () => { serverExited = true; });

const waitReady = async () => {
  for (let i = 0; i < 60; i++) {
    if (serverExited) return false;
    try {
      const r = await fetch(BASE + '/api/units');
      if (r.ok || r.status === 401) return true;
    } catch { }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
};

try {
  console.log('=== 轻进销存 综合测试（隔离库）===');
  const ready = await waitReady();
  check('服务启动', ready);
  if (!ready) throw new Error(`服务未能启动（端口 ${PORT} 可能被占用）`);

  // ---------- 基础资料 ----------
  let r = await api('GET', '/api/units');
  check('默认单位>=6', r.status === 200 && r.data.length >= 6, JSON.stringify(r.data?.length));
  const jian = r.data.find(u => u.name === '件');
  const xiang = r.data.find(u => u.name === '箱');
  check('单位: 件/箱存在', !!(jian && xiang));
  check('单位: 箱折算=24', xiang && xiang.ratio === 24, JSON.stringify(xiang));
  // 香料、干货铺子按斤卖是刚需，默认单位表里必须有
  const jin = r.data.find(u => u.name === '斤');
  check('单位: 斤存在且折算=0.5公斤', jin && jin.ratio === 0.5 && jin.dimension === 'weight', JSON.stringify(jin));
  const unitOrder = r.data.map(u => u.name);
  check('单位顺序: 斤紧跟公斤之后', unitOrder.indexOf('斤') === unitOrder.indexOf('公斤') + 1, JSON.stringify(unitOrder));

  r = await api('POST', '/api/units', { name: '袋', dimension: 'count', ratio: 5, weight_per: 1, sort_order: 99 });
  check('新增单位', r.status === 200 && r.data.id > 0, JSON.stringify(r.data));
  const daiId = r.data.id;
  r = await api('PUT', '/api/units/' + daiId, { name: '袋装', dimension: 'count', ratio: 5, sort_order: 99 });
  check('编辑单位', r.status === 200);
  r = await api('GET', '/api/units');
  check('单位列表含新单位', r.data.some(u => u.name === '袋装'));
  await api('DELETE', '/api/units/' + daiId);
  r = await api('GET', '/api/units');
  check('停用单位后默认列表不含它', !r.data.some(u => u.id === daiId), JSON.stringify(r.data.map(u => u.name)));
  r = await api('GET', '/api/units?includeInactive=1');
  check('includeInactive 能看到停用单位', r.data.find(u => u.id === daiId)?.active === 0, JSON.stringify(r.data.find(u => u.id === daiId)));
  r = await api('POST', `/api/units/${daiId}/restore`);
  check('恢复停用单位', r.status === 200);
  r = await api('GET', '/api/units');
  check('恢复后重新出现在默认列表', r.data.some(u => u.id === daiId && u.active === 1));

  r = await api('GET', '/api/warehouses');
  check('默认仓库>=1', r.status === 200 && r.data.length >= 1, JSON.stringify(r.data));
  const whId = r.data[0].id;
  r = await api('POST', '/api/warehouses', { name: '二号仓', code: 'WH02' });
  check('新增仓库', r.status === 200 && r.data.id > 0);
  const wh2 = r.data.id;
  r = await api('PUT', '/api/warehouses/' + wh2, { name: '二号仓(改)', code: 'WH02' });
  check('编辑仓库', r.status === 200);
  r = await api('GET', '/api/warehouses');
  check('仓库列表含新仓库', r.data.some(w => w.name === '二号仓(改)'));
  await api('DELETE', '/api/warehouses/' + wh2);
  r = await api('GET', '/api/warehouses');
  check('停用仓库', !r.data.some(w => w.id === wh2));

  r = await api('POST', '/api/suppliers', { name: '甲供应商', phone: '13800000000' });
  const supId = r.data.id;
  check('新增供应商', r.status === 200 && supId > 0);
  r = await api('POST', '/api/customers', { name: '乙客户', phone: '13900000000' });
  const cusId = r.data.id;
  check('新增客户', r.status === 200 && cusId > 0);
  r = await api('PUT', '/api/suppliers/' + supId, { name: '甲供应商改', contact: '张三' });
  check('编辑供应商', r.status === 200);
  r = await api('GET', '/api/suppliers');
  check('供应商列表', r.data.some(s => s.name === '甲供应商改'));
  await api('DELETE', '/api/suppliers/' + supId);
  r = await api('GET', '/api/suppliers');
  check('停用供应商后列表不含', !r.data.some(s => s.id === supId));
  await api('DELETE', '/api/customers/' + cusId);

  r = await api('POST', '/api/products', {
    name: '矿泉水', sku: 'SKU-001', category: '饮品', spec: '550ml', base_unit_id: jian.id,
    weight_per_base_kg: 0.5, purchase_price: 1, sale_price: 1.5, stock_low: 10, remark: '测试',
    custom_data: { origin: '云南' }
  });
  const prodId = r.data.id;
  check('新增商品', r.status === 200 && prodId > 0);
  r = await api('GET', '/api/products');
  const p1 = r.data.find(p => p.id === prodId);
  check('商品列表含新商品', !!p1);
  check('商品自定义字段保留', p1 && p1.custom_data.includes('云南'), JSON.stringify(p1?.custom_data));
  r = await api('GET', '/api/products/categories');
  check('商品分类列表', r.data.includes('饮品'));
  r = await api('PUT', '/api/products/' + prodId, {
    name: '矿泉水', sku: 'SKU-001', category: '饮品', spec: '600ml', base_unit_id: jian.id,
    weight_per_base_kg: 0.6, purchase_price: 1, sale_price: 1.5, stock_low: 5, custom_data: { origin: '云南' }
  });
  check('编辑商品', r.status === 200);
  r = await api('GET', '/api/products?keyword=矿泉水');
  check('商品搜索', r.data.length === 1 && r.data[0].spec === '600ml');

  r = await api('POST', '/api/import/products', {
    rows: [
      { name: '导入品A', category: '食品', base_unit: '件', purchase_price: 2, sale_price: 3, stock_low: 1 },
      { name: '导入品B', category: '食品', base_unit: '箱', purchase_price: 20, sale_price: 30 }
    ]
  });
  check('Excel 导入新增', r.status === 200 && r.data.ok === 2 && r.data.skipped === 0, JSON.stringify(r.data));
  r = await api('POST', '/api/import/products', { rows: [{ name: '导入品A', category: '食品2', base_unit: '件', purchase_price: 5, sale_price: 6 }] });
  check('Excel 导入更新(同名)', r.status === 200 && r.data.ok === 1, JSON.stringify(r.data));
  r = await api('GET', '/api/products?keyword=导入品A');
  check('导入更新生效', r.data[0]?.category === '食品2' && r.data[0]?.purchase_price === 5, JSON.stringify(r.data[0]));

  // ---------- 自定义字段 ----------
  r = await api('POST', '/api/custom-fields', { entity: 'product', name: 'origin', label: '产地', field_type: 'text' });
  const cfId = r.data.id;
  check('新增自定义字段', r.status === 200 && cfId > 0);
  r = await api('POST', '/api/custom-fields', { entity: 'product', name: 'origin', label: '产地2', field_type: 'text' });
  check('重复字段名拒绝', r.status === 400);
  r = await api('GET', '/api/custom-fields?entity=product');
  check('自定义字段列表', r.data.some(f => f.name === 'origin'));
  r = await api('PUT', '/api/custom-fields/' + cfId, { entity: 'product', name: 'origin', label: '产地(改)', field_type: 'text', options: [] });
  check('编辑自定义字段', r.status === 200);
  await api('DELETE', '/api/custom-fields/' + cfId);
  r = await api('GET', '/api/custom-fields?entity=product');
  check('删除自定义字段', !r.data.some(f => f.id === cfId));

  // ---------- 采购入库 ----------
  r = await api('POST', '/api/purchase-orders', {
    supplier_id: supId, warehouse_id: whId, order_date: new Date().toISOString().slice(0, 10), remark: '首批',
    items: [{ product_id: prodId, unit_id: xiang.id, quantity: 5, unit_price: 22 }]
  });
  check('采购入库 5箱=120件 金额110', r.status === 200 && r.data.total_amount === 110, JSON.stringify(r.data));
  const poId = r.data.id;
  const poNo = r.data.order_no;
  check('采购单号格式', /^CG\d{8}-\d{4}$/.test(poNo || ''), poNo);

  // 回归：修复后的单据列表（含筛选）
  r = await api('GET', '/api/purchase-orders');
  check('[回归] 进货单列表 200', r.status === 200 && r.data.length === 1, `${r.status}`);
  const poRow = r.data[0];
  check('进货单列表字段完整', poRow && poRow.partner_name === '甲供应商改' && poRow.warehouse_name && poRow.item_count === 1, JSON.stringify(poRow));
  r = await api('GET', '/api/purchase-orders?partnerId=' + supId);
  check('进货单按供应商筛选', r.data.length === 1);
  r = await api('GET', '/api/purchase-orders?partnerId=99999');
  check('进货单筛选不存在的供应商', r.data.length === 0);
  r = await api('GET', '/api/purchase-orders?keyword=' + encodeURIComponent(poNo));
  check('进货单按单号搜索', r.data.length === 1);
  r = await api('GET', '/api/purchase-orders?from=2099-01-01');
  check('进货单按日期范围过滤', r.data.length === 0);
  r = await api('GET', '/api/purchase-orders/' + poId);
  check('进货单详情', r.status === 200 && r.data.items?.[0]?.quantity_base === 120 && r.data.items[0].unit_name === '箱', JSON.stringify(r.data.items?.[0]));

  r = await api('GET', '/api/stock');
  const s1 = r.data.find(s => s.product_id === prodId);
  check('库存=120', s1 && s1.quantity === 120, JSON.stringify(s1));
  check('库存金额=110', s1 && s1.stock_value === 110);
  // 商品已在上方编辑为 weight_per_base_kg=0.6，故 120 * 0.6 = 72
  check('库存重量=72kg(按最新单重)', s1 && s1.weight_kg === 72, JSON.stringify(s1));
  r = await api('GET', '/api/stock?warehouseId=' + whId);
  check('库存按仓库筛选', r.data.every(s => s.warehouse_id === whId));
  r = await api('GET', '/api/products');
  check('平均成本=0.9167', Math.abs(r.data.find(p => p.id === prodId).avg_cost - 110 / 120) < 0.001);

  // ---------- 销售出库 ----------
  r = await api('POST', '/api/sales-orders', {
    customer_id: cusId, warehouse_id: whId, order_date: new Date().toISOString().slice(0, 10),
    items: [{ product_id: prodId, unit_id: jian.id, quantity: 30, unit_price: 1.5 }]
  });
  check('销售出库 30件=45元', r.status === 200 && r.data.total_amount === 45, JSON.stringify(r.data));
  const soId = r.data.id;
  r = await api('GET', '/api/sales-orders');
  check('[回归] 出货单列表 200', r.status === 200 && r.data.length === 1, `${r.status}`);
  check('出货单列表字段完整', r.data[0].partner_name === '乙客户' && r.data[0].item_count === 1, JSON.stringify(r.data[0]));
  r = await api('GET', '/api/stock');
  check('出货后库存=90', r.data.find(s => s.product_id === prodId).quantity === 90);

  r = await api('GET', '/api/reports/profit');
  check('毛利=45-27.5=17.5', r.data.total.profit === 17.5 && Math.abs(r.data.total.cost - 27.5) < 0.001, JSON.stringify(r.data.total));
  r = await api('GET', '/api/reports/purchase?groupBy=product');
  check('进货报表(按商品)', r.data.rows[0]?.amount === 110, JSON.stringify(r.data.rows));
  r = await api('GET', '/api/reports/purchase?groupBy=partner');
  check('进货报表(按供应商)', r.data.rows[0]?.name === '甲供应商改');
  r = await api('GET', '/api/reports/purchase?groupBy=day');
  check('进货报表(按日期)', r.data.rows[0]?.amount === 110);
  r = await api('GET', '/api/reports/sales?groupBy=product');
  check('出货报表(按商品)', r.data.rows[0]?.amount === 45);
  r = await api('GET', '/api/reports/sales?groupBy=day');
  check('出货报表(按日期)', r.data.rows[0]?.amount === 45);
  r = await api('GET', '/api/reports/profit?productId=' + prodId);
  check('毛利按商品筛选', r.data.total.amount === 45);

  r = await api('GET', '/api/reports/dashboard');
  check('仪表盘接口', r.status === 200 && r.data.trend.length === 30);
  check('仪表盘统计', r.data.stats.todayPurchase === 110 && r.data.stats.todaySales === 45 && r.data.stats.lowStockCount === 0, JSON.stringify(r.data.stats));

  r = await api('GET', '/api/ledger');
  check('流水>=2条', r.data.length >= 2, `count=${r.data.length}`);
  r = await api('GET', '/api/ledger?type=purchase_in');
  check('流水按类型过滤', r.data.length === 1 && r.data[0].type === 'purchase_in');
  r = await api('GET', '/api/ledger?productId=' + prodId);
  check('流水按商品过滤', r.data.length === 2);
  const todayStr = new Date().toISOString().slice(0, 10);
  r = await api('GET', '/api/ledger?from=' + todayStr + '&to=' + todayStr);
  check('流水按日期过滤', r.data.length >= 2);

  // ---------- 作废与成本 ----------
  // 此时已进 120、卖出 30，库存 90。作废这张采购单意味着这 120 件从未入库，
  // 但其中 30 件已经卖掉了，所以真实库存是 90-120 = -30。
  // 新版如实保留负数（旧的写法会夹成 0，把账面缺口悄悄抹平）。
  r = await api('POST', `/api/purchase-orders/${poId}/void`);
  check('作废采购单', r.status === 200);
  check('作废返回负数库存明细（供界面提示）',
    Array.isArray(r.data.negative) && r.data.negative.length === 1
    && r.data.negative[0].product_id === prodId && r.data.negative[0].quantity === -30,
    JSON.stringify(r.data));
  r = await api('GET', '/api/stock');
  const sVoid = r.data.find(s => s.product_id === prodId);
  check('作废采购后库存=-30（负数如实保留，不再夹成0）', sVoid && sVoid.quantity === -30, JSON.stringify(sVoid));
  await checkStockEqualsLedger(prodId, whId, '作废采购后');
  r = await api('GET', '/api/products');
  const avgAfterVoid = r.data.find(p => p.id === prodId).avg_cost;
  check('作废采购后平均成本=0', avgAfterVoid === 0, `实际 avg_cost=${avgAfterVoid}（BUG：成本未冲销）`);
  r = await api('POST', `/api/purchase-orders/${poId}/void`);
  check('重复作废拒绝', r.status === 400);

  // 重新采购，然后作废销售单验证库存回补
  // 从 -30 起：-30 +120 = 90，卖 30 后 60，作废该销售单回补到 90
  r = await api('POST', '/api/purchase-orders', {
    supplier_id: supId, warehouse_id: whId, order_date: todayStr,
    items: [{ product_id: prodId, unit_id: xiang.id, quantity: 5, unit_price: 22 }]
  });
  const po2 = r.data.id;
  r = await api('POST', '/api/sales-orders', {
    customer_id: cusId, warehouse_id: whId, order_date: todayStr,
    items: [{ product_id: prodId, unit_id: jian.id, quantity: 30, unit_price: 1.5 }]
  });
  const so2 = r.data.id;
  r = await api('POST', `/api/sales-orders/${so2}/void`);
  check('作废销售单', r.status === 200);
  check('作废销售单不产生负库存提示', Array.isArray(r.data.negative) && r.data.negative.length === 0, JSON.stringify(r.data));
  r = await api('GET', '/api/stock');
  check('作废销售后库存回补=90', r.data.find(s => s.product_id === prodId).quantity === 90,
    JSON.stringify(r.data.find(s => s.product_id === prodId)));
  await checkStockEqualsLedger(prodId, whId, '作废销售后');

  // 超卖场景（记录当前行为）
  r = await api('POST', '/api/sales-orders', {
    customer_id: cusId, warehouse_id: whId, order_date: todayStr,
    items: [{ product_id: prodId, unit_id: jian.id, quantity: 500, unit_price: 1.5 }]
  });
  const overSellStatus = r.status;
  r = await api('GET', '/api/stock');
  const stockAfterOverSell = r.data.find(s => s.product_id === prodId);
  check('超卖被拦截(期望400)', overSellStatus === 400, `实际 status=${overSellStatus}`);
  check('超卖被拦截后库存不变=90', stockAfterOverSell && stockAfterOverSell.quantity === 90, JSON.stringify(stockAfterOverSell));

  // ---------- 库存调整 ----------
  r = await api('POST', '/api/stock/adjust', { product_id: prodId, warehouse_id: whId, unit_id: jian.id, delta_qty: 50, remark: '盘点' });
  check('库存调整+50', r.status === 200);
  r = await api('GET', '/api/stock');
  check('调整后库存=140', r.data.find(s => s.product_id === prodId)?.quantity === 140,
    JSON.stringify(r.data.find(s => s.product_id === prodId)));
  await checkStockEqualsLedger(prodId, whId, '库存调整后');
  r = await api('POST', '/api/stock/adjust', { product_id: prodId, warehouse_id: whId, unit_id: jian.id, delta_qty: 0 });
  check('调整为0拒绝', r.status === 400);
  r = await api('POST', '/api/stock/adjust', { product_id: prodId, warehouse_id: whId, unit_id: jian.id, delta_qty: -500 });
  check('盘点调减超出实存允许', r.status === 200, `实际 status=${r.status}`);
  r = await api('GET', '/api/stock');
  check('调减超出实存后库存=-360（如实保留负数）',
    r.data.find(s => s.product_id === prodId)?.quantity === -360,
    JSON.stringify(r.data.find(s => s.product_id === prodId)));
  await checkStockEqualsLedger(prodId, whId, '调减超出实存后');
  await api('POST', '/api/stock/adjust', { product_id: prodId, warehouse_id: whId, unit_id: jian.id, delta_qty: 360, remark: '复位' });
  r = await api('POST', '/api/stock/adjust', { product_id: prodId, warehouse_id: 999999, unit_id: jian.id, delta_qty: 10 });
  check('调整到不存在仓库被拒绝', r.status === 400, `实际 status=${r.status}（BUG：可写孤立库存行）`);

  // ---------- 移动加权平均成本（本次改动的核心回归）----------
  // 旧算法是「全历史采购总额 ÷ 全历史采购数量」，等于把已经卖出那部分货物的
  // 历史采购成本一直留在分母里。香料价格波动大，这个偏差会直接算进毛利。
  const huajiao = await api('POST', '/api/products', {
    name: '花椒', category: '香料', base_unit_id: jian.id, purchase_price: 10, sale_price: 15
  });
  const hjId = huajiao.data.id;
  // 进 100 @10 → 卖 50（均价 10，结转成本 500）→ 再进 100 @20
  // 正确：池 (150, 2500) → 均价 16.6667；旧算法：3000/200 = 15
  await api('POST', '/api/purchase-orders', {
    supplier_id: supId, warehouse_id: whId, order_date: todayStr,
    items: [{ product_id: hjId, unit_id: jian.id, quantity: 100, unit_price: 10 }]
  });
  await api('POST', '/api/sales-orders', {
    customer_id: cusId, warehouse_id: whId, order_date: todayStr,
    items: [{ product_id: hjId, unit_id: jian.id, quantity: 50, unit_price: 15 }]
  });
  await api('POST', '/api/purchase-orders', {
    supplier_id: supId, warehouse_id: whId, order_date: todayStr,
    items: [{ product_id: hjId, unit_id: jian.id, quantity: 100, unit_price: 20 }]
  });
  r = await api('GET', '/api/products');
  const hjAvg = r.data.find(p => p.id === hjId).avg_cost;
  check('移动加权：卖一半后再涨价进货，均价=16.67（旧算法给15）',
    Math.abs(hjAvg - 2500 / 150) < 0.001, `实际 avg_cost=${hjAvg}`);

  // 出库必须按当时均价结转成本，否则毛利依然不对。
  // 报表汇总该商品全部出库：第一笔 50 件按均价 10 结转 500，
  // 第二笔 50 件必须按 16.67 结转 833.33（旧算法会按 15 结转 750）。
  await api('POST', '/api/sales-orders', {
    customer_id: cusId, warehouse_id: whId, order_date: todayStr,
    items: [{ product_id: hjId, unit_id: jian.id, quantity: 50, unit_price: 30 }]
  });
  r = await api('GET', '/api/reports/profit?productId=' + hjId);
  check('移动加权：第二笔出库按16.67结转，两笔成本合计1333.33',
    Math.abs(r.data.total.cost - (500 + (2500 / 150) * 50)) < 0.05, JSON.stringify(r.data.total));
  check('移动加权：毛利率不被虚高（40.74%而非44.4%）',
    Math.abs(r.data.total.rate - 40.74) < 0.1, `实际 rate=${r.data.total.rate}`);
  await checkStockEqualsLedger(hjId, whId, '香料场景');

  // 卖光后再进货：成本池已归零，新进货价就是新均价
  const bajiao = await api('POST', '/api/products', {
    name: '八角', category: '香料', base_unit_id: jian.id, purchase_price: 10, sale_price: 15
  });
  const bjId = bajiao.data.id;
  await api('POST', '/api/purchase-orders', {
    supplier_id: supId, warehouse_id: whId, order_date: todayStr,
    items: [{ product_id: bjId, unit_id: jian.id, quantity: 100, unit_price: 10 }]
  });
  await api('POST', '/api/sales-orders', {
    customer_id: cusId, warehouse_id: whId, order_date: todayStr,
    items: [{ product_id: bjId, unit_id: jian.id, quantity: 100, unit_price: 15 }]
  });
  await api('POST', '/api/purchase-orders', {
    supplier_id: supId, warehouse_id: whId, order_date: todayStr,
    items: [{ product_id: bjId, unit_id: jian.id, quantity: 100, unit_price: 20 }]
  });
  r = await api('GET', '/api/products');
  const bjAvg = r.data.find(p => p.id === bjId).avg_cost;
  check('移动加权：卖光后再进货，均价=20（旧算法给15）', Math.abs(bjAvg - 20) < 0.001, `实际 avg_cost=${bjAvg}`);

  // ---------- 开单提速：常卖商品 / 历史价 ----------
  r = await api('GET', `/api/order-suggest?kind=sales&partnerId=${cusId}`);
  check('常卖商品接口可用', r.status === 200 && Array.isArray(r.data.products), JSON.stringify(r.data).slice(0, 120));
  const sug = r.data.products;
  check('常卖商品按该客户的成交频次降序',
    sug.length >= 2 && sug[0].order_count >= sug[sug.length - 1].order_count,
    JSON.stringify(sug.map(s => [s.name, s.order_count])));
  const hjSug = sug.find(s => s.product_id === hjId);
  check('带出该客户的上次成交价（花椒 30，而非商品默认售价15）',
    hjSug && hjSug.last_price === 30, JSON.stringify(hjSug));
  check('带出上次用的单位', hjSug && hjSug.last_unit_id === jian.id, JSON.stringify(hjSug));

  r = await api('GET', '/api/order-suggest?kind=sales');
  check('不传往来单位时退化为全店最近商品', r.status === 200 && r.data.products.length >= 2,
    JSON.stringify(r.data.products.map(s => s.name)));

  // 进货侧同样可用；停用的商品不应出现在常卖列表里
  r = await api('POST', '/api/products', { name: '待停用品', base_unit_id: jian.id });
  const tmpId = r.data.id;
  await api('POST', '/api/purchase-orders', {
    supplier_id: supId, warehouse_id: whId, order_date: todayStr,
    items: [{ product_id: tmpId, unit_id: jian.id, quantity: 5, unit_price: 7 }]
  });
  r = await api('GET', `/api/order-suggest?kind=purchase&partnerId=${supId}`);
  check('进货侧也能取常卖商品', r.data.products.some(s => s.product_id === tmpId), JSON.stringify(r.data.products.map(s => s.name)));
  check('进货侧带出上次进价', (r.data.products.find(s => s.product_id === tmpId) || {}).last_price === 7);
  await api('DELETE', '/api/products/' + tmpId);
  r = await api('GET', `/api/order-suggest?kind=purchase&partnerId=${supId}`);
  check('停用商品从常卖列表移除', !r.data.products.some(s => s.product_id === tmpId), JSON.stringify(r.data.products.map(s => s.name)));

  // ---------- 单据修改 ----------
  r = await api('POST', '/api/products', { name: '改单测试品', base_unit_id: jian.id, purchase_price: 10, sale_price: 20 });
  const epId = r.data.id;
  r = await api('POST', '/api/purchase-orders', {
    supplier_id: supId, warehouse_id: whId, order_date: todayStr,
    items: [{ product_id: epId, unit_id: jian.id, quantity: 100, unit_price: 10 }]
  });
  const epoId = r.data.id;
  r = await api('POST', '/api/sales-orders', {
    customer_id: cusId, warehouse_id: whId, order_date: todayStr,
    items: [{ product_id: epId, unit_id: jian.id, quantity: 20, unit_price: 20 }]
  });
  const esoId = r.data.id;

  // 只改备注：不能写流水、不能重算成本
  const ledBefore = (await api('GET', '/api/ledger?productId=' + epId)).data;
  const avgBefore = (await api('GET', '/api/products')).data.find(p => p.id === epId).avg_cost;
  r = await api('PUT', `/api/sales-orders/${esoId}`, {
    customer_id: cusId, order_date: todayStr, remark: '只改备注',
    items: [{ product_id: epId, unit_id: jian.id, quantity: 20, unit_price: 20 }]
  });
  check('只改备注成功且判定为未改明细', r.status === 200 && r.data.itemsChanged === false, JSON.stringify(r.data));
  check('只改备注不写流水', (await api('GET', '/api/ledger?productId=' + epId)).data.length === ledBefore.length);
  check('只改备注不改成本', (await api('GET', '/api/products')).data.find(p => p.id === epId).avg_cost === avgBefore);

  // 改数量 20 → 30
  r = await api('PUT', `/api/sales-orders/${esoId}`, {
    customer_id: cusId, order_date: todayStr, remark: '改数量',
    items: [{ product_id: epId, unit_id: jian.id, quantity: 30, unit_price: 20 }]
  });
  check('改数量成功', r.status === 200 && r.data.itemsChanged === true, JSON.stringify(r.data));
  check('改数量后单据金额=600', r.data.total_amount === 600, JSON.stringify(r.data));
  r = await api('GET', `/api/sales-orders/${esoId}`);
  check('明细被替换而非叠加', r.data.items.length === 1 && r.data.items[0].quantity === 30,
    JSON.stringify(r.data.items.map(i => i.quantity)));
  r = await api('GET', '/api/stock?productId=' + epId);
  check('改单后库存=70', r.data[0]?.quantity === 70, JSON.stringify(r.data));
  await checkStockEqualsLedger(epId, whId, '改单后');
  r = await api('GET', '/api/reports/profit?productId=' + epId);
  check('改单后成本按均价结转=300', Math.abs(r.data.total.cost - 300) < 0.001, JSON.stringify(r.data.total));

  // 改过的单再作废：不能出现重复冲销
  r = await api('POST', `/api/sales-orders/${esoId}/void`);
  check('改过的单可以作废', r.status === 200);
  r = await api('GET', '/api/stock?productId=' + epId);
  check('改单后再作废，库存回到100', r.data[0]?.quantity === 100, JSON.stringify(r.data));
  await checkStockEqualsLedger(epId, whId, '改单后作废');

  // 编辑失败要整体回滚
  r = await api('POST', '/api/sales-orders', {
    customer_id: cusId, warehouse_id: whId, order_date: todayStr,
    items: [{ product_id: epId, unit_id: jian.id, quantity: 10, unit_price: 20 }]
  });
  const eso2 = r.data.id;
  const ledN = (await api('GET', '/api/ledger?productId=' + epId)).data.length;
  const stockN = (await api('GET', '/api/stock?productId=' + epId)).data[0]?.quantity;
  r = await api('PUT', `/api/sales-orders/${eso2}`, {
    customer_id: cusId, order_date: todayStr,
    items: [{ product_id: epId, unit_id: jian.id, quantity: 9999, unit_price: 20 }]
  });
  check('改单超库存被拒绝', r.status === 400, JSON.stringify(r.data));
  check('改单失败后流水未变', (await api('GET', '/api/ledger?productId=' + epId)).data.length === ledN, `原 ${ledN}`);
  check('改单失败后库存未变', (await api('GET', '/api/stock?productId=' + epId)).data[0]?.quantity === stockN, `原 ${stockN}`);

  // 采购单在销售之后改价：要给出「不重算历史毛利」的警告
  r = await api('PUT', `/api/purchase-orders/${epoId}`, {
    supplier_id: supId, order_date: todayStr,
    items: [{ product_id: epId, unit_id: jian.id, quantity: 100, unit_price: 11 }]
  });
  check('采购单卖出后改价返回警告', r.status === 200 && !!r.data.warning, JSON.stringify(r.data));
  await checkStockEqualsLedger(epId, whId, '采购单改价后');
  r = await api('GET', '/api/products');
  check('采购单改价后均价跟到11', Math.abs(r.data.find(p => p.id === epId).avg_cost - 11) < 0.001,
    `实际 ${r.data.find(p => p.id === epId).avg_cost}`);

  // ---------- 删除恢复 ----------
  r = await api('POST', '/api/products', { name: '恢复测试品', base_unit_id: jian.id });
  const restorePid = r.data.id;
  await api('DELETE', '/api/products/' + restorePid);
  check('停用商品默认不显示', !(await api('GET', '/api/products')).data.some(p => p.id === restorePid));
  r = await api('GET', '/api/products?includeInactive=1');
  check('includeInactive 能看到停用商品', r.data.some(p => p.id === restorePid && p.active === 0));
  r = await api('POST', `/api/products/${restorePid}/restore`);
  check('恢复商品', r.status === 200);
  check('恢复后重新显示', (await api('GET', '/api/products')).data.some(p => p.id === restorePid && p.active === 1));

  // 同名冲突：停用后新建同名，应可识别并引导恢复
  r = await api('POST', '/api/suppliers', { name: '恢复测试供应商' });
  const restoreSid = r.data.id;
  await api('DELETE', '/api/suppliers/' + restoreSid);
  r = await api('POST', '/api/suppliers', { name: '恢复测试供应商' });
  check('新建同名停用记录返回409并带inactive_id',
    r.status === 409 && r.data.inactive_id === restoreSid, JSON.stringify(r.data));
  r = await api('POST', `/api/suppliers/${restoreSid}/restore`);
  check('按inactive_id恢复供应商', r.status === 200);
  check('恢复后供应商重新出现', (await api('GET', '/api/suppliers')).data.some(s => s.id === restoreSid));

  // ---------- 参数校验 ----------
  r = await api('POST', '/api/purchase-orders', { items: [] });
  check('缺供应商/仓库校验', r.status === 400);
  r = await api('POST', '/api/purchase-orders', { supplier_id: 999999, warehouse_id: whId, items: [{ product_id: prodId, unit_id: jian.id, quantity: 1 }] });
  check('不存在的供应商拒绝', r.status === 400);
  r = await api('POST', '/api/purchase-orders', { supplier_id: supId, warehouse_id: whId, items: [{ product_id: prodId, unit_id: jian.id, quantity: 0 }] });
  check('数量为0拒绝', r.status === 400);
  r = await api('POST', '/api/purchase-orders', { supplier_id: supId, warehouse_id: whId, items: [{ product_id: prodId, unit_id: 999999, quantity: 1 }] });
  check('不存在单位拒绝', r.status === 400);

  // ---------- 导出 ----------
  for (const [ep, name] of [['/api/export/products', '商品'], ['/api/export/stock', '库存'], ['/api/export/purchase', '进货明细'], ['/api/export/sales', '出货明细'], ['/api/export/ledger', '库存流水'], ['/api/export/profit', '毛利']]) {
    r = await api('GET', ep, null, null, true);
    let rowsOk = false;
    try {
      const wb = XLSX.read(r.buf);
      const ws = wb.Sheets[wb.SheetNames[0]];
      rowsOk = XLSX.utils.sheet_to_json(ws).length > 0;
    } catch { }
    check(`导出 ${name}`, r.status === 200 && r.buf.length > 100 && rowsOk, `${r.status}, bytes=${r.buf.length}`);
  }

  // ---------- 备份 ----------
  r = await api('POST', '/api/backups');
  check('手动备份', r.status === 200 && r.data.list.length >= 1, JSON.stringify(r.data.list));
  r = await api('GET', '/api/backups');
  check('备份列表', r.status === 200 && r.data.length >= 1);
  const bkName = r.data[0].name;
  r = await api('GET', '/api/backups/download?file=' + encodeURIComponent(bkName), null, null, true);
  check('备份下载', r.status === 200 && r.buf.length > 1000, `${r.status}, bytes=${r.buf.length}`);

  // ---------- 从备份恢复 ----------
  r = await api('POST', '/api/products', { name: '恢复要被回退的商品', base_unit_id: jian.id });
  check('恢复前新增一个商品', r.status === 200);
  r = await api('POST', '/api/backups/restore', { file: bkName });
  check('从备份恢复成功', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  r = await api('GET', '/api/products?keyword=' + encodeURIComponent('恢复要被回退的商品'));
  check('恢复后新增的商品被回退', r.data.length === 0, JSON.stringify(r.data.map(p => p.name)));
  r = await api('GET', '/api/products');
  check('恢复后原有商品仍在', r.data.some(p => p.name === '矿泉水'), JSON.stringify(r.data.map(p => p.name)));
  r = await api('GET', '/api/backups');
  check('恢复前自动留了安全备份', r.data.some(b => b.name.includes('before-restore')), JSON.stringify(r.data.map(b => b.name)));
  // 拿错文件不能把库覆盖坏
  r = await api('POST', '/api/backups/restore', { file: '../../package.json' });
  check('恢复非备份文件被拒绝', r.status === 400, JSON.stringify(r.data));
  r = await api('GET', '/api/products');
  check('拒绝后数据仍在', r.data.some(p => p.name === '矿泉水'));

  // ---------- 设置与鉴权 ----------
  r = await api('GET', '/api/settings');
  check('设置读取', r.status === 200 && r.data.business_name === '我的店铺' && r.data.password_required === false);
  r = await api('PUT', '/api/settings', { business_name: '测试店' });
  check('保存设置', r.status === 200);
  r = await api('GET', '/api/settings');
  check('设置生效', r.data.business_name === '测试店');

  r = await api('PUT', '/api/settings', { access_password: '123456' });
  check('设置密码', r.status === 200);
  r = await api('GET', '/api/units');
  check('设密码后未带token=401', r.status === 401);
  r = await api('POST', '/api/login', { password: 'wrong' });
  check('错误密码拒绝', r.status === 401);
  r = await api('POST', '/api/login', { password: '123456' });
  check('正确密码登录', r.status === 200 && !!r.data.token);
  const token = r.data.token;
  r = await api('GET', '/api/units', null, token);
  check('带token访问成功', r.status === 200);
  // 修复后的前端保存其他设置时不再携带 access_password 字段
  r = await api('PUT', '/api/settings', { business_name: '测试店2', auto_backup_hours: 6 }, token);
  r = await api('GET', '/api/settings', null, token);
  check('保存其他设置不清空密码', r.data.password_required === true, `实际 password_required=${r.data.password_required}`);
  r = await api('PUT', '/api/settings', { access_password: '' }, token);
  r = await api('GET', '/api/units');
  check('清除密码后免登录', r.status === 200);

  console.log('');
  console.log(`结果: ${RESULT.ok.length} 通过, ${RESULT.fail.length} 失败/发现问题`);
} catch (e) {
  console.error('测试异常:', e);
  RESULT.fail.push('异常:' + e.message);
} finally {
  server.kill();
  process.exit(RESULT.fail.length ? 1 : 0);
}
