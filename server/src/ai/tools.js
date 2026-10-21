import { db, round } from '../db.js';
import { buildContext } from './prompt.js';
import { createPendingAction } from './permissions.js';

// 只读工具：所有查询都是参数化 SELECT + LIMIT，不提供任意 SQL。
// SQL 口径与 routes/stock.js、routes/reports.js 保持一致；
// 如果以后调整库存/报表口径，记得两处一起改，避免 AI 和页面各说各话。

const MAX_ROWS = 200;
const DEFAULT_ROWS = 50;
const TYPE_TEXT = {
  purchase_in: '采购入库',
  sale_out: '销售出库',
  adjustment: '库存调整',
  reversal: '作废冲销'
};

function asOf() {
  return db.prepare("SELECT datetime('now','localtime') AS t").get().t;
}
function clampLimit(v, def = DEFAULT_ROWS) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), MAX_ROWS);
}
function moneyCard(label, value) { return { label, value: Number(value) || 0, format: 'money' }; }
function qtyCard(label, value, unit) { return { label, value: Number(value) || 0, format: 'qty', unit }; }
function intCard(label, value) { return { label, value: Number(value) || 0, format: 'int' }; }
function metricsCard(title, metrics, note) { return { type: 'metrics', title, metrics, note }; }
function tableCard(title, columns, rows, note) { return { type: 'table', title, columns, rows, note }; }
function warningCard(title, text) { return { type: 'warning', title, text }; }

function ok(data, { meta = {}, notes = [], cards = [] } = {}) {
  return { ok: true, as_of: asOf(), data, meta: { row_count: 0, truncated: false, ...meta }, notes, cards };
}
function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

function resolveWarehouse(value) {
  if (value === undefined || value === null || value === '') return { all: true };
  const s = String(value).trim();
  if (/^\d+$/.test(s)) {
    const row = db.prepare('SELECT * FROM warehouses WHERE id=?').get(Number(s));
    if (row) return { row };
  }
  const exact = db.prepare('SELECT * FROM warehouses WHERE name=?').all(s);
  if (exact.length === 1) return { row: exact[0] };
  const like = db.prepare('SELECT * FROM warehouses WHERE name LIKE ? LIMIT 10').all(`%${s}%`);
  if (like.length === 1) return { row: like[0] };
  if (like.length > 1) return { ambiguous: like };
  return { notFound: true };
}

function productCandidates(value) {
  const s = String(value || '').trim();
  if (!s) return [];
  return db.prepare(`
    SELECT p.id, p.name, p.sku, p.spec, p.category, p.base_unit_id, u.name AS unit_name, p.active,
      COALESCE((SELECT SUM(s.quantity) FROM stock s WHERE s.product_id=p.id),0) AS stock_qty
    FROM products p LEFT JOIN units u ON u.id=p.base_unit_id
    WHERE p.name=? OR p.sku=? OR p.barcode=?
    ORDER BY p.active DESC, p.id DESC LIMIT 10`).all(s, s, s);
}
function resolveProduct(value) {
  if (value === undefined || value === null || value === '') return { notFound: true };
  const s = String(value).trim();
  if (/^\d+$/.test(s)) {
    const row = db.prepare(`
      SELECT p.*, u.name AS unit_name, u.dimension AS unit_dimension, u.ratio AS unit_ratio
      FROM products p LEFT JOIN units u ON u.id=p.base_unit_id WHERE p.id=?`).get(Number(s));
    if (row) return { row };
  }
  let rows = productCandidates(s);
  if (!rows.length) {
    rows = db.prepare(`
      SELECT p.id, p.name, p.sku, p.spec, p.category, p.base_unit_id, u.name AS unit_name, p.active,
        COALESCE((SELECT SUM(s.quantity) FROM stock s WHERE s.product_id=p.id),0) AS stock_qty
      FROM products p LEFT JOIN units u ON u.id=p.base_unit_id
      WHERE p.name LIKE ? ORDER BY p.active DESC, p.id DESC LIMIT 10`).all(`%${s}%`);
  }
  if (rows.length === 1) return { row: rows[0] };
  if (rows.length > 1) return { ambiguous: rows };
  return { notFound: true };
}

function resolvePartner(kind, value) {
  const table = kind === 'supplier' ? 'suppliers' : 'customers';
  if (value === undefined || value === null || value === '') return { notFound: true };
  const s = String(value).trim();
  if (/^\d+$/.test(s)) {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(Number(s));
    if (row) return { row };
  }
  const exact = db.prepare(`SELECT * FROM ${table} WHERE name=?`).all(s);
  if (exact.length === 1) return { row: exact[0] };
  const like = db.prepare(`SELECT * FROM ${table} WHERE name LIKE ? LIMIT 10`).all(`%${s}%`);
  if (like.length === 1) return { row: like[0] };
  if (like.length > 1) return { ambiguous: like };
  return { notFound: true };
}

// ---------- 写操作：解析与校验 ----------

function resolveUnit(value) {
  if (value === undefined || value === null || String(value).trim() === '') return { notFound: true };
  const s = String(value).trim();
  if (/^\d+$/.test(s)) {
    const row = db.prepare('SELECT * FROM units WHERE id=? AND active=1').get(Number(s));
    if (row) return { row };
  }
  const exact = db.prepare('SELECT * FROM units WHERE name=? AND active=1').all(s);
  if (exact.length === 1) return { row: exact[0] };
  const like = db.prepare('SELECT * FROM units WHERE name LIKE ? AND active=1 LIMIT 10').all(`%${s}%`);
  if (like.length === 1) return { row: like[0] };
  if (like.length > 1) return { ambiguous: like };
  return { notFound: true };
}

function getProductFull(id) {
  return db.prepare(`
    SELECT p.*, u.name AS unit_name, u.dimension AS unit_dimension, u.ratio AS unit_ratio
    FROM products p LEFT JOIN units u ON u.id=p.base_unit_id WHERE p.id=?`).get(id);
}
function currentQty(productId, warehouseId) {
  const row = db.prepare('SELECT quantity FROM stock WHERE product_id=? AND warehouse_id=?').get(productId, warehouseId);
  return row ? Number(row.quantity) || 0 : 0;
}
function todayStr() {
  return db.prepare("SELECT date('now','localtime') AS d").get().d;
}
function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function baseUnitRatioWarning(product, warnings) {
  // 现有服务把 quantity * unit.ratio 当作库存基准数量。
  // 如果商品基准单位本身不是 1 倍单位（如把“箱”设为基准），手工开单和 AI 都可能出现口径偏差，
  // 这里至少提示用户先确认商品资料。
  if (product.unit_ratio !== null && product.unit_ratio !== undefined && Number(product.unit_ratio) !== 1) {
    warnings.push(`「${product.name}」的基准单位不是 1 倍单位（ratio=${product.unit_ratio}），请确认库存口径`);
  }
}

function buildOrderLines(items, kind, warehouseId, warehouseName, stockBuffer = null) {
  if (!Array.isArray(items) || !items.length) {
    return { error: fail('INVALID_ARG', '请至少提供一条商品明细') };
  }
  const lines = [];
  const warnings = [];
  const isPurchase = kind === 'purchase';

  for (const raw of items) {
    if (!raw || !raw.product) return { error: fail('INVALID_ARG', '每条明细都必须有商品') };
    const pr = resolveProduct(raw.product);
    if (pr.ambiguous) {
      return { error: fail('AMBIGUOUS', '商品名称不唯一，请让用户选择', {
        candidates: pr.ambiguous.map(x => ({ id: x.id, name: x.name, spec: x.spec }))
      }) };
    }
    if (pr.notFound) return { error: fail('NOT_FOUND', `没有找到商品「${raw.product}」`) };
    const product = getProductFull(pr.row.id);
    if (!product) return { error: fail('NOT_FOUND', `没有找到商品「${raw.product}」`) };
    if (!product.base_unit_id || !product.unit_dimension) {
      return { error: fail('INVALID_PRODUCT', `商品「${product.name}」没有可用的基准单位，不能开单`) };
    }

    let unit;
    if (raw.unit !== undefined && raw.unit !== null && String(raw.unit).trim() !== '') {
      const ur = resolveUnit(raw.unit);
      if (ur.ambiguous) {
        return { error: fail('AMBIGUOUS', '单位名称不唯一，请让用户选择', {
          candidates: ur.ambiguous.map(u => ({ id: u.id, name: u.name, dimension: u.dimension }))
        }) };
      }
      if (ur.notFound) return { error: fail('NOT_FOUND', `没有找到单位「${raw.unit}」`) };
      unit = ur.row;
    } else {
      unit = db.prepare('SELECT * FROM units WHERE id=? AND active=1').get(product.base_unit_id);
      if (!unit) return { error: fail('INVALID_PRODUCT', `商品「${product.name}」的基准单位不可用`) };
    }
    if (unit.dimension !== product.unit_dimension) {
      return { error: fail('INVALID_ARG', `单位「${unit.name}」与商品「${product.name}」的计量体系不一致`) };
    }

    const quantity = Number(raw.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { error: fail('INVALID_ARG', `商品「${product.name}」的数量必须大于 0`) };
    }

    let unitPrice;
    if (raw.unit_price === undefined || raw.unit_price === null || raw.unit_price === '') {
      unitPrice = Number(isPurchase ? product.purchase_price : product.sale_price) || 0;
      warnings.push(`「${product.name}」未指定单价，已使用商品默认${isPurchase ? '进价' : '售价'} ¥${unitPrice}`);
    } else {
      unitPrice = Number(raw.unit_price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        return { error: fail('INVALID_ARG', `商品「${product.name}」的单价不合法`) };
      }
    }

    const ratio = Number(unit.ratio) || 1;
    const qtyBase = round(quantity * ratio);
    const amount = round(quantity * unitPrice);
    const baseEquivalentPrice = round(unitPrice / ratio);

    if (isPurchase) {
      if (Number(product.avg_cost) > 0 && (baseEquivalentPrice > product.avg_cost * 3 || baseEquivalentPrice < product.avg_cost / 3)) {
        warnings.push(`「${product.name}」单价与当前平均成本 ¥${product.avg_cost} 差异较大，请确认`);
      }
      if (!Number(product.avg_cost)) warnings.push(`「${product.name}」还没有成本，确认后将按本单重算`);
    } else if (Number(product.sale_price) > 0 && (baseEquivalentPrice > product.sale_price * 3 || baseEquivalentPrice < product.sale_price / 3)) {
      warnings.push(`「${product.name}」单价与默认售价 ¥${product.sale_price} 差异较大，请确认`);
    }
    if (product.active === 0) warnings.push(`「${product.name}」已停用`);
    baseUnitRatioWarning(product, warnings);

    const remark = raw.remark ? String(raw.remark) : '';
    lines.push({
      product,
      unit,
      quantity,
      unitPrice,
      qtyBase,
      amount,
      remark,
      resolved: { product_id: product.id, unit_id: unit.id, quantity, unit_price: unitPrice, remark }
    });
  }

  // 同一商品多行时合并检查库存，避免逐行校验漏掉总和
  const agg = new Map();
  for (const line of lines) {
    const key = line.product.id;
    if (!agg.has(key)) agg.set(key, { product: line.product, qtyBase: 0, amount: 0 });
    const a = agg.get(key);
    a.qtyBase = round(a.qtyBase + line.qtyBase);
    a.amount = round(a.amount + line.amount);
  }
  const stockChanges = [];
  for (const [pid, a] of agg) {
    const before = currentQty(pid, warehouseId);
    const available = before + (stockBuffer?.get(pid) || 0);
    if (!isPurchase && available + 1e-9 < a.qtyBase) {
      return { error: fail('INSUFFICIENT_STOCK', `库存不足：${a.product.name}（可用 ${round(available)} ${a.product.unit_name || ''}，需要 ${round(a.qtyBase)}）`, {
        details: [{ product_id: pid, name: a.product.name, available: round(available), need: round(a.qtyBase) }]
      }) };
    }
    const delta = isPurchase ? a.qtyBase : -a.qtyBase;
    stockChanges.push({
      product_id: pid,
      product_name: a.product.name,
      warehouse_id: warehouseId,
      warehouse_name: warehouseName,
      unit_name: a.product.unit_name || '',
      before: round(before),
      delta: round(delta),
      after: round(before + delta)
    });
  }

  return { lines, warnings, stockChanges };
}

function buildOrderProposal(kind, args = {}) {
  const isPurchase = kind === 'purchase';
  const partnerKey = isPurchase ? 'supplier' : 'customer';
  if (!args[partnerKey]) return { error: fail('INVALID_ARG', `请提供${isPurchase ? '供应商' : '客户'}`) };
  if (!args.warehouse) return { error: fail('INVALID_ARG', '请提供仓库') };

  const partner = resolvePartner(partnerKey, args[partnerKey]);
  if (partner.ambiguous) {
    return { error: fail('AMBIGUOUS', `${isPurchase ? '供应商' : '客户'}名称不唯一，请让用户选择`, {
      candidates: partner.ambiguous.map(x => ({ id: x.id, name: x.name }))
    }) };
  }
  if (partner.notFound) return { error: fail('NOT_FOUND', `没有找到${isPurchase ? '供应商' : '客户'}「${args[partnerKey]}」`) };

  const wh = resolveWarehouse(args.warehouse);
  if (wh.ambiguous) {
    return { error: fail('AMBIGUOUS', '仓库名称不唯一，请让用户选择', {
      candidates: wh.ambiguous.map(x => ({ id: x.id, name: x.name }))
    }) };
  }
  if (wh.notFound) return { error: fail('NOT_FOUND', `没有找到仓库「${args.warehouse}」`) };

  const lineRes = buildOrderLines(args.items, kind, wh.row.id, wh.row.name);
  if (lineRes.error) return lineRes;

  const orderDate = args.order_date ? String(args.order_date) : todayStr();
  if (!validDate(orderDate)) return { error: fail('INVALID_ARG', '日期格式应为 YYYY-MM-DD') };

  const warnings = [...lineRes.warnings];
  if (partner.row.active === 0) warnings.push(`${isPurchase ? '供应商' : '客户'}「${partner.row.name}」已停用`);
  if (wh.row.active === 0) warnings.push(`仓库「${wh.row.name}」已停用`);

  const totalAmount = round(lineRes.lines.reduce((s, l) => s + l.amount, 0));
  const preview = {
    kind: isPurchase ? 'purchase_order' : 'sales_order',
    title: isPurchase ? '进货单' : '出货单',
    [isPurchase ? 'supplier_name' : 'customer_name']: partner.row.name,
    warehouse_name: wh.row.name,
    order_date: orderDate,
    items: lineRes.lines.map(l => ({
      product_name: l.product.name,
      product_spec: l.product.spec || '',
      unit_name: l.unit.name,
      quantity: l.quantity,
      unit_price: l.unitPrice,
      amount: l.amount,
      qty_base: l.qtyBase,
      remark: l.remark
    })),
    total_amount: totalAmount,
    stock_changes: lineRes.stockChanges,
    remark: args.remark ? String(args.remark) : ''
  };
  const resolved = {
    [isPurchase ? 'supplier_id' : 'customer_id']: partner.row.id,
    warehouse_id: wh.row.id,
    order_date: orderDate,
    remark: args.remark ? String(args.remark) : '',
    items: lineRes.lines.map(l => l.resolved)
  };
  return { ok: true, preview, warnings, resolved };
}

function buildAdjustmentProposal(args = {}) {
  if (!args.product) return { error: fail('INVALID_ARG', '请提供商品') };
  if (!args.warehouse) return { error: fail('INVALID_ARG', '请提供仓库') };
  const pr = resolveProduct(args.product);
  if (pr.ambiguous) {
    return { error: fail('AMBIGUOUS', '商品名称不唯一，请让用户选择', {
      candidates: pr.ambiguous.map(x => ({ id: x.id, name: x.name, spec: x.spec }))
    }) };
  }
  if (pr.notFound) return { error: fail('NOT_FOUND', `没有找到商品「${args.product}」`) };
  const product = getProductFull(pr.row.id);
  if (!product || !product.base_unit_id || !product.unit_dimension) {
    return { error: fail('INVALID_PRODUCT', '该商品没有可用的基准单位，不能调整库存') };
  }
  const wh = resolveWarehouse(args.warehouse);
  if (wh.ambiguous) {
    return { error: fail('AMBIGUOUS', '仓库名称不唯一，请让用户选择', {
      candidates: wh.ambiguous.map(x => ({ id: x.id, name: x.name }))
    }) };
  }
  if (wh.notFound) return { error: fail('NOT_FOUND', `没有找到仓库「${args.warehouse}」`) };

  let unit;
  if (args.unit !== undefined && args.unit !== null && String(args.unit).trim() !== '') {
    const ur = resolveUnit(args.unit);
    if (ur.ambiguous) return { error: fail('AMBIGUOUS', '单位名称不唯一，请让用户选择', { candidates: ur.ambiguous.map(u => ({ id: u.id, name: u.name })) }) };
    if (ur.notFound) return { error: fail('NOT_FOUND', `没有找到单位「${args.unit}」`) };
    unit = ur.row;
  } else {
    unit = db.prepare('SELECT * FROM units WHERE id=? AND active=1').get(product.base_unit_id);
    if (!unit) return { error: fail('INVALID_PRODUCT', '该商品的基准单位不可用') };
  }
  if (unit.dimension !== product.unit_dimension) {
    return { error: fail('INVALID_ARG', `单位「${unit.name}」与商品「${product.name}」的计量体系不一致`) };
  }

  const delta = Number(args.delta_qty);
  if (!Number.isFinite(delta) || delta === 0) return { error: fail('INVALID_ARG', '调整数量不能为 0') };
  const reason = String(args.reason || '').trim();
  if (!reason) return { error: fail('INVALID_ARG', '库存调整必须填写原因') };

  const qtyBase = round(delta * (Number(unit.ratio) || 1));
  const before = currentQty(product.id, wh.row.id);
  const after = round(before + qtyBase);
  const warnings = [];
  if (product.active === 0) warnings.push(`商品「${product.name}」已停用`);
  if (wh.row.active === 0) warnings.push(`仓库「${wh.row.name}」已停用`);
  if (after < 0) warnings.push(`调整后库存为负数（${after} ${product.unit_name || ''}），请确认`);
  baseUnitRatioWarning(product, warnings);

  const preview = {
    kind: 'stock_adjustment',
    title: '库存调整',
    product_name: product.name,
    product_spec: product.spec || '',
    warehouse_name: wh.row.name,
    unit_name: unit.name,
    delta_qty: delta,
    delta_base: qtyBase,
    before: round(before),
    after,
    base_unit_name: product.unit_name || '',
    reason
  };
  const resolved = {
    product_id: product.id,
    warehouse_id: wh.row.id,
    unit_id: unit.id,
    delta_qty: delta,
    remark: reason
  };
  return { ok: true, preview, warnings, resolved };
}

function proposeOrder(kind, args = {}, context = {}) {
  if (!context.session) return fail('NO_SESSION', 'AI 会话不存在或已过期，请刷新页面重试');
  if (!['write', 'danger'].includes(context.permission?.level)) return fail('PERMISSION_DENIED', '请先在 AI 面板顶部授权「可记账」或「高风险」');
  const build = buildOrderProposal(kind, args);
  if (build.error) return build.error;
  const type = kind === 'purchase' ? 'purchase_order' : 'sales_order';
  const pending = createPendingAction(context.session, {
    type,
    args,
    preview: build.preview,
    warnings: build.warnings
  });
  const action = {
    action_id: pending.action_id,
    confirm_token: pending.confirm_token,
    expires_at: pending.expires_at,
    type,
    preview: build.preview,
    warnings: build.warnings
  };
  return {
    ...ok({
      action_id: pending.action_id,
      expires_at: pending.expires_at,
      preview: build.preview,
      warnings: build.warnings
    }, {
      notes: [
        `已生成待确认的${kind === 'purchase' ? '进货单' : '出货单'}。必须让用户在卡片上点“确认执行”；不要声称已经写入。`,
        '确认后才会真正写库；写入前会自动备份。'
      ]
    }),
    action
  };
}

function proposePurchase(args = {}, context = {}) {
  return proposeOrder('purchase', args, context);
}
function proposeSales(args = {}, context = {}) {
  return proposeOrder('sales', args, context);
}
function proposeAdjustment(args = {}, context = {}) {
  if (!context.session) return fail('NO_SESSION', 'AI 会话不存在或已过期，请刷新页面重试');
  if (!['write', 'danger'].includes(context.permission?.level)) return fail('PERMISSION_DENIED', '请先在 AI 面板顶部授权「可记账」或「高风险」');
  const build = buildAdjustmentProposal(args);
  if (build.error) return build.error;
  const type = 'stock_adjustment';
  const pending = createPendingAction(context.session, {
    type,
    args,
    preview: build.preview,
    warnings: build.warnings
  });
  const action = {
    action_id: pending.action_id,
    confirm_token: pending.confirm_token,
    expires_at: pending.expires_at,
    type,
    preview: build.preview,
    warnings: build.warnings
  };
  return {
    ...ok({
      action_id: pending.action_id,
      expires_at: pending.expires_at,
      preview: build.preview,
      warnings: build.warnings
    }, {
      notes: [
        '已生成待确认的库存调整。必须让用户在卡片上点“确认执行”；不要声称已经写入。',
        '确认后才会真正写库；写入前会自动备份。'
      ]
    }),
    action
  };
}

// ---------- 高风险：作废 / 改单 ----------

function getOrderWithItems(kind, args = {}) {
  const isPurchase = kind === 'purchase';
  const table = isPurchase ? 'purchase_orders' : 'sales_orders';
  const itemTable = isPurchase ? 'purchase_order_items' : 'sales_order_items';
  const partnerJoin = isPurchase ? 'LEFT JOIN suppliers sp ON sp.id=o.supplier_id' : 'LEFT JOIN customers cu ON cu.id=o.customer_id';
  const partnerName = isPurchase ? 'sp.name AS partner_name' : 'cu.name AS partner_name';
  const where = args.id ? 'o.id=?' : 'o.order_no=?';
  const value = args.id || args.order_no;
  if (!value) return { error: fail('INVALID_ARG', '需要单据 ID 或单号') };
  const order = db.prepare(`
    SELECT o.*, ${partnerName}, w.name AS warehouse_name
    FROM ${table} o ${partnerJoin}
    LEFT JOIN warehouses w ON w.id=o.warehouse_id
    WHERE ${where}`).get(value);
  if (!order) return { error: fail('NOT_FOUND', '单据不存在') };
  const items = db.prepare(`
    SELECT i.*, p.name AS product_name, p.spec AS product_spec,
      u.name AS unit_name, bu.name AS base_unit_name
    FROM ${itemTable} i
    JOIN products p ON p.id=i.product_id
    LEFT JOIN units u ON u.id=i.unit_id
    LEFT JOIN units bu ON bu.id=p.base_unit_id
    WHERE i.order_id=? ORDER BY i.id`).all(order.id);
  return { order, items, isPurchase };
}

function buildVoidProposal(args = {}) {
  const kind = args.kind === 'purchase' ? 'purchase' : args.kind === 'sales' ? 'sales' : '';
  if (!kind) return { error: fail('INVALID_ARG', 'kind 必须是 purchase 或 sales') };
  const reason = String(args.reason || '').trim();
  if (!reason) return { error: fail('INVALID_ARG', '作废单据必须填写原因') };
  const got = getOrderWithItems(kind, args);
  if (got.error) return got;
  const { order, items, isPurchase } = got;
  if (order.status !== 'done') return { error: fail('INVALID_ORDER', '这张单据已经作废，不能重复操作') };

  const agg = new Map();
  for (const it of items) {
    if (!agg.has(it.product_id)) agg.set(it.product_id, { product_name: it.product_name, unit_name: it.base_unit_name || it.unit_name || '', qty_base: 0 });
    agg.get(it.product_id).qty_base = round(agg.get(it.product_id).qty_base + it.quantity_base);
  }
  const warnings = ['作废会反向冲销库存和成本，并保留流水痕迹；此操作不可撤销。'];
  const stockChanges = [];
  for (const [pid, a] of agg) {
    const before = currentQty(pid, order.warehouse_id);
    const delta = isPurchase ? -a.qty_base : a.qty_base;
    const after = round(before + delta);
    stockChanges.push({
      product_id: pid,
      product_name: a.product_name,
      warehouse_name: order.warehouse_name,
      unit_name: a.unit_name,
      before: round(before),
      delta: round(delta),
      after
    });
    if (after < 0) warnings.push(`作废后「${a.product_name}」库存为负（${after} ${a.unit_name}），说明货已卖出或已盘点调整`);
  }
  const preview = {
    kind: 'void_order',
    order_kind: kind,
    title: isPurchase ? '作废进货单' : '作废出货单',
    order_id: order.id,
    order_no: order.order_no,
    order_date: order.order_date,
    partner_name: order.partner_name || '',
    warehouse_name: order.warehouse_name || '',
    total_amount: order.total_amount,
    items: items.map(it => ({
      product_name: it.product_name,
      product_spec: it.product_spec || '',
      quantity: it.quantity,
      unit_name: it.unit_name || '',
      unit_price: it.unit_price,
      amount: it.amount,
      qty_base: it.quantity_base
    })),
    stock_changes: stockChanges,
    reason
  };
  return {
    ok: true,
    preview,
    warnings,
    resolved: { kind, order_id: order.id, reason }
  };
}

function buildUpdateProposal(args = {}) {
  const kind = args.kind === 'purchase' ? 'purchase' : args.kind === 'sales' ? 'sales' : '';
  if (!kind) return { error: fail('INVALID_ARG', 'kind 必须是 purchase 或 sales') };
  const got = getOrderWithItems(kind, args);
  if (got.error) return got;
  const { order, items, isPurchase } = got;
  if (order.status !== 'done') return { error: fail('INVALID_ORDER', '已作废的单据不能修改') };

  const partnerKey = isPurchase ? 'supplier' : 'customer';
  let partnerId = order[isPurchase ? 'supplier_id' : 'customer_id'];
  let partnerName = order.partner_name || '';
  if (args[partnerKey]) {
    const p = resolvePartner(isPurchase ? 'supplier' : 'customer', args[partnerKey]);
    if (p.ambiguous) return { error: fail('AMBIGUOUS', '往来单位名称不唯一，请让用户选择', { candidates: p.ambiguous.map(x => ({ id: x.id, name: x.name })) }) };
    if (p.notFound) return { error: fail('NOT_FOUND', `没有找到${isPurchase ? '供应商' : '客户'}「${args[partnerKey]}」`) };
    partnerId = p.row.id;
    partnerName = p.row.name;
  }

  const orderDate = args.order_date ? String(args.order_date) : order.order_date;
  if (!validDate(orderDate)) return { error: fail('INVALID_ARG', '日期格式应为 YYYY-MM-DD') };
  const remark = args.remark !== undefined ? String(args.remark) : (order.remark || '');

  const inputItems = Array.isArray(args.items) && args.items.length
    ? args.items
    : items.map(it => ({
        product: it.product_id, unit: it.unit_id, quantity: it.quantity,
        unit_price: it.unit_price, remark: it.remark
      }));

  const oldQty = new Map();
  const oldNames = new Map();
  for (const it of items) {
    oldQty.set(it.product_id, round((oldQty.get(it.product_id) || 0) + it.quantity_base));
    oldNames.set(it.product_id, { name: it.product_name, unit: it.base_unit_name || it.unit_name || '' });
  }
  const lineRes = buildOrderLines(inputItems, kind, order.warehouse_id, order.warehouse_name, isPurchase ? null : oldQty);
  if (lineRes.error) return lineRes;

  const newQty = new Map();
  const newNames = new Map();
  for (const line of lineRes.lines) {
    newQty.set(line.product.id, round((newQty.get(line.product.id) || 0) + line.qtyBase));
    newNames.set(line.product.id, { name: line.product.name, unit: line.product.unit_name || line.unit.name });
  }
  const allPids = new Set([...oldQty.keys(), ...newQty.keys()]);
  const warnings = [...lineRes.warnings];
  const stockChanges = [];
  for (const pid of allPids) {
    const before = currentQty(pid, order.warehouse_id);
    const old = oldQty.get(pid) || 0;
    const next = newQty.get(pid) || 0;
    const net = isPurchase ? round(next - old) : round(old - next);
    const after = round(before + net);
    const name = newNames.get(pid) || oldNames.get(pid) || { name: `#${pid}`, unit: '' };
    stockChanges.push({
      product_id: pid,
      product_name: name.name,
      warehouse_name: order.warehouse_name,
      unit_name: name.unit,
      before: round(before),
      delta: net,
      after
    });
    if (after < 0) warnings.push(`修改后「${name.name}」库存为负（${after} ${name.unit}），请确认`);
  }

  const sig = rows => rows.map(r =>
    `${r.product_id || r.product?.id}|${r.unit_id || r.unit?.id}|${Number(r.quantity)}|${Number(r.unit_price)}|${r.remark || ''}`
  ).join(';');
  const oldSig = sig(items);
  const newSig = sig(lineRes.lines.map(l => ({
    product_id: l.product.id, unit_id: l.unit.id, quantity: l.quantity, unit_price: l.unitPrice, remark: l.remark
  })));
  const itemsChanged = oldSig !== newSig;
  if (isPurchase && itemsChanged) warnings.push('修改进货单会红冲后重记；已卖出的部分不会重述历史毛利，只影响当前库存成本');
  if (!isPurchase && itemsChanged) warnings.push('修改出货单会红冲原成本并重记，历史毛利会变化');
  if (partnerId !== order[isPurchase ? 'supplier_id' : 'customer_id']) warnings.push(`往来单位将改为「${partnerName}」`);
  if (!itemsChanged) warnings.push('只修改表头（日期/备注/往来单位），不会改动库存和成本');

  const totalAmount = round(lineRes.lines.reduce((s, l) => s + l.amount, 0));
  const preview = {
    kind: 'update_order',
    order_kind: kind,
    title: isPurchase ? '修改进货单' : '修改出货单',
    order_id: order.id,
    order_no: order.order_no,
    partner_name: partnerName,
    old_partner_name: order.partner_name || '',
    warehouse_name: order.warehouse_name || '',
    order_date: orderDate,
    old_order_date: order.order_date,
    old_total_amount: order.total_amount,
    total_amount: totalAmount,
    items: lineRes.lines.map(l => ({
      product_name: l.product.name,
      product_spec: l.product.spec || '',
      quantity: l.quantity,
      unit_name: l.unit.name,
      unit_price: l.unitPrice,
      amount: l.amount,
      qty_base: l.qtyBase,
      remark: l.remark
    })),
    old_items: items.map(it => ({
      product_name: it.product_name,
      product_spec: it.product_spec || '',
      quantity: it.quantity,
      unit_name: it.unit_name || '',
      unit_price: it.unit_price,
      amount: it.amount
    })),
    stock_changes: stockChanges,
    items_changed: itemsChanged,
    remark
  };
  const resolved = {
    kind,
    order_id: order.id,
    order_date: orderDate,
    remark,
    [isPurchase ? 'supplier_id' : 'customer_id']: partnerId,
    items: lineRes.lines.map(l => l.resolved)
  };
  return { ok: true, preview, warnings, resolved };
}

function proposeVoid(args = {}, context = {}) {
  if (!context.session) return fail('NO_SESSION', 'AI 会话不存在或已过期，请刷新页面重试');
  if (context.permission?.level !== 'danger') return fail('PERMISSION_DENIED', '请先授权「高风险」权限');
  const build = buildVoidProposal(args);
  if (build.error) return build.error;
  const pending = createPendingAction(context.session, {
    type: 'void_order', args, preview: build.preview, warnings: build.warnings
  });
  const action = {
    action_id: pending.action_id,
    confirm_token: pending.confirm_token,
    expires_at: pending.expires_at,
    type: 'void_order',
    preview: build.preview,
    warnings: build.warnings
  };
  return {
    ...ok({
      action_id: pending.action_id,
      expires_at: pending.expires_at,
      preview: build.preview,
      warnings: build.warnings
    }, {
      notes: [
        '已生成待确认的作废提案。必须让用户在卡片上点“确认作废”；不要声称已经作废。',
        '作废会冲回库存和成本，不可撤销；确认前会自动备份。'
      ]
    }),
    action
  };
}

function proposeUpdate(args = {}, context = {}) {
  if (!context.session) return fail('NO_SESSION', 'AI 会话不存在或已过期，请刷新页面重试');
  if (context.permission?.level !== 'danger') return fail('PERMISSION_DENIED', '请先授权「高风险」权限');
  const build = buildUpdateProposal(args);
  if (build.error) return build.error;
  const pending = createPendingAction(context.session, {
    type: 'update_order', args, preview: build.preview, warnings: build.warnings
  });
  const action = {
    action_id: pending.action_id,
    confirm_token: pending.confirm_token,
    expires_at: pending.expires_at,
    type: 'update_order',
    preview: build.preview,
    warnings: build.warnings
  };
  return {
    ...ok({
      action_id: pending.action_id,
      expires_at: pending.expires_at,
      preview: build.preview,
      warnings: build.warnings
    }, {
      notes: [
        '已生成待确认的改单提案。必须让用户在卡片上点“确认执行”；不要声称已经修改。',
        '改单会红冲后重记，库存和成本会变化；确认前会自动备份。'
      ]
    }),
    action
  };
}

// 供确认接口重新校验：返回最新的 preview / resolved，调用方比较 preview 是否变化。
export function validateAction(action) {
  if (!action || !action.type) return { ok: false, error: '无效的操作类型' };
  let out;
  if (action.type === 'purchase_order') out = buildOrderProposal('purchase', action.args || {});
  else if (action.type === 'sales_order') out = buildOrderProposal('sales', action.args || {});
  else if (action.type === 'stock_adjustment') out = buildAdjustmentProposal(action.args || {});
  else if (action.type === 'void_order') out = buildVoidProposal(action.args || {});
  else if (action.type === 'update_order') out = buildUpdateProposal(action.args || {});
  else return { ok: false, error: '未知的操作类型' };

  if (out.error) {
    return {
      ok: false,
      code: out.error.code || 'VALIDATION_FAILED',
      error: out.error.error || '操作校验失败'
    };
  }
  return { ok: true, preview: out.preview, warnings: out.warnings, resolved: out.resolved };
}

function buildStockScope(args = {}) {
  const wh = resolveWarehouse(args.warehouse);
  if (wh.ambiguous) return { error: fail('AMBIGUOUS', '仓库名称不唯一，请让用户选择', { candidates: wh.ambiguous.map(w => ({ id: w.id, name: w.name })) }) };
  if (wh.notFound) return { error: fail('NOT_FOUND', `没有找到仓库「${args.warehouse}」`) };

  const conditions = [];
  const params = [];
  if (wh.row) { conditions.push('s.warehouse_id=?'); params.push(wh.row.id); }
  if (args.category) { conditions.push('p.category=?'); params.push(String(args.category)); }
  if (args.keyword) {
    conditions.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)');
    const k = `%${String(args.keyword)}%`;
    params.push(k, k, k);
  }
  return {
    wh,
    conditions,
    params,
    where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '',
    and: conditions.length ? ' AND ' + conditions.join(' AND ') : ''
  };
}

function stockBase(args) {
  return `
    FROM stock s
    JOIN products p ON p.id=s.product_id
    LEFT JOIN units u ON u.id=p.base_unit_id
    JOIN warehouses w ON w.id=s.warehouse_id
    ${args.where}`;
}

// ---------- 只读工具 ----------

function getContext() {
  const ctx = buildContext();
  const counts = {
    products: db.prepare('SELECT COUNT(*) c FROM products WHERE active=1').get().c,
    suppliers: db.prepare('SELECT COUNT(*) c FROM suppliers WHERE active=1').get().c,
    customers: db.prepare('SELECT COUNT(*) c FROM customers WHERE active=1').get().c,
    purchase_orders: db.prepare('SELECT COUNT(*) c FROM purchase_orders WHERE status=\'done\'').get().c,
    sales_orders: db.prepare('SELECT COUNT(*) c FROM sales_orders WHERE status=\'done\'').get().c
  };
  return ok({ ...ctx, counts }, { meta: { source: 'settings/warehouses/units/products' } });
}

function resolveEntity(args = {}) {
  const type = String(args.type || '');
  const query = String(args.query || '').trim();
  if (!query) return fail('INVALID_ARG', '缺少 query');
  let candidates = [];
  if (type === 'warehouse') {
    const r = resolveWarehouse(query);
    if (r.row) candidates = [r.row];
    else if (r.ambiguous) candidates = r.ambiguous;
  } else if (type === 'product') {
    candidates = productCandidates(query);
    if (!candidates.length) {
      candidates = db.prepare(`
        SELECT p.id, p.name, p.sku, p.spec, p.category, p.base_unit_id, u.name AS unit_name, p.active,
          COALESCE((SELECT SUM(s.quantity) FROM stock s WHERE s.product_id=p.id),0) AS stock_qty
        FROM products p LEFT JOIN units u ON u.id=p.base_unit_id
        WHERE p.name LIKE ? ORDER BY p.active DESC, p.id DESC LIMIT 10`).all(`%${query}%`);
    }
  } else if (type === 'supplier' || type === 'customer') {
    const table = type === 'supplier' ? 'suppliers' : 'customers';
    candidates = db.prepare(`SELECT id, name, contact, active FROM ${table} WHERE name LIKE ? ORDER BY active DESC, id DESC LIMIT 10`).all(`%${query}%`);
  } else {
    return fail('INVALID_ARG', 'type 必须是 warehouse/product/supplier/customer');
  }

  const data = {
    type,
    query,
    candidates: candidates.map(c => ({
      id: c.id,
      name: c.name,
      spec: c.spec || '',
      sku: c.sku || '',
      category: c.category || '',
      unit: c.unit_name || '',
      stock_qty: c.stock_qty ?? undefined,
      active: c.active
    }))
  };
  const cards = candidates.length > 1
    ? [tableCard('找到多个匹配项，请确认', [
        { prop: 'id', label: 'ID', format: 'int', width: 70 },
        { prop: 'name', label: '名称' },
        { prop: 'spec', label: '规格' },
        { prop: 'unit', label: '单位' }
      ], data.candidates)]
    : [];
  return ok(data, { meta: { row_count: candidates.length, source: type }, cards });
}

function stockSummary(args = {}) {
  const scope = buildStockScope(args);
  if (scope.error) return scope.error;

  const dimRows = db.prepare(`
    SELECT COALESCE(u.dimension, 'unknown') AS dimension,
      ROUND(SUM(s.quantity * COALESCE(u.ratio, 1)), 3) AS qty,
      ROUND(SUM(s.quantity * p.avg_cost), 2) AS cost_value,
      ROUND(SUM(s.quantity * p.sale_price), 2) AS retail_value,
      COUNT(DISTINCT p.id) AS products
    ${stockBase(scope)}
    GROUP BY COALESCE(u.dimension, 'unknown')
    ORDER BY dimension`).all(...scope.params);

  const totals = db.prepare(`
    SELECT COUNT(DISTINCT p.id) AS products,
      ROUND(COALESCE(SUM(s.quantity * p.avg_cost),0),2) AS cost_value,
      ROUND(COALESCE(SUM(s.quantity * p.sale_price),0),2) AS retail_value
    ${stockBase(scope)}`).get(...scope.params);

  const extra = (condition, extraParams = []) => {
    const conds = [...scope.conditions, condition].join(' AND ');
    return db.prepare(`
      SELECT COUNT(DISTINCT p.id) AS c
      FROM stock s JOIN products p ON p.id=s.product_id
      LEFT JOIN units u ON u.id=p.base_unit_id
      ${conds ? 'WHERE ' + conds : ''}`).get(...scope.params, ...extraParams).c;
  };

  const lowStock = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT p.id, COALESCE(SUM(s.quantity),0) AS qty
      FROM products p
      LEFT JOIN stock s ON s.product_id=p.id AND (?=0 OR s.warehouse_id=?)
      LEFT JOIN units u ON u.id=p.base_unit_id
      WHERE p.active=1 AND p.stock_low>0
        ${args.category ? 'AND p.category=?' : ''}
      GROUP BY p.id
      HAVING qty < p.stock_low
    )`).get(scope.wh.row ? scope.wh.row.id : 0, scope.wh.row ? scope.wh.row.id : 0, ...(args.category ? [args.category] : [])).c;

  const negativeCount = extra('s.quantity < 0');
  const zeroCostCount = extra('s.quantity > 0 AND COALESCE(p.avg_cost,0)=0');
  const zeroSaleCount = extra('s.quantity > 0 AND COALESCE(p.sale_price,0)=0');
  const missingUnitCount = extra('(p.base_unit_id IS NULL OR u.id IS NULL) AND s.quantity <> 0');
  const inactiveCount = extra('p.active=0 AND s.quantity <> 0');

  const top = db.prepare(`
    SELECT p.name, u.name AS unit_name,
      ROUND(SUM(s.quantity), 3) AS qty,
      ROUND(SUM(s.quantity * p.avg_cost), 2) AS cost_value
    ${stockBase(scope)}
    GROUP BY p.id ORDER BY cost_value DESC LIMIT 10`).all(...scope.params);

  const byCategory = db.prepare(`
    SELECT COALESCE(NULLIF(p.category,''), '未分类') AS category,
      ROUND(SUM(s.quantity * p.avg_cost), 2) AS cost_value,
      COUNT(DISTINCT p.id) AS products
    ${stockBase(scope)}
    GROUP BY COALESCE(NULLIF(p.category,''), '未分类')
    ORDER BY cost_value DESC LIMIT 20`).all(...scope.params);

  const byDimension = dimRows.map(r => ({
    dimension: r.dimension,
    qty: r.qty,
    unit: r.dimension === 'weight' ? '公斤' : r.dimension === 'count' ? '件' : '未知单位',
    cost_value: r.cost_value,
    retail_value: r.retail_value,
    products: r.products
  }));

  const scopeName = scope.wh.row ? scope.wh.row.name : '全部仓库';
  const notes = [
    '件类与重量类数量不能相加，已按计量维度分开',
    '库存金额 = 结存数量 × 移动加权平均成本；售价估算 = 结存数量 × 默认售价',
    `数据时间 ${asOf()}，范围：${scopeName}`
  ];
  if (zeroCostCount) notes.push(`${zeroCostCount} 个商品有库存但平均成本为 0，库存金额可能偏低`);
  if (zeroSaleCount) notes.push(`${zeroSaleCount} 个商品有库存但未设置默认售价，售价估算可能偏低`);
  if (negativeCount) notes.push(`${negativeCount} 个商品存在负库存，这是账实不符信号`);
  if (missingUnitCount) notes.push(`${missingUnitCount} 个商品缺少基准单位，已归入“未知单位”`);
  if (inactiveCount) notes.push(`${inactiveCount} 个有库存的商品已停用，仍计入本次汇总`);
  if (byCategory.length >= 20) notes.push('分类汇总仅显示金额前 20 类');
  if (!totals.products) notes.push('该范围内没有库存记录');

  const cards = [metricsCard(`${scopeName}库存概览`, [
    moneyCard('库存金额(成本)', totals.cost_value),
    moneyCard('售价估算', totals.retail_value),
    intCard('有库存商品数', totals.products),
    ...byDimension.map(d => qtyCard(d.dimension === 'weight' ? '重量类数量' : d.dimension === 'count' ? '件类数量' : '未知单位数量', d.qty, d.unit)),
    intCard('低库存', lowStock),
    intCard('负库存', negativeCount)
  ], notes[0])];
  if (top.length) cards.push(tableCard('库存价值 Top 10', [
    { prop: 'name', label: '商品' },
    { prop: 'qty', label: '结存', format: 'qty', unit: '基准单位' },
    { prop: 'unit_name', label: '单位', width: 70 },
    { prop: 'cost_value', label: '库存金额', format: 'money' }
  ], top));
  if (zeroCostCount || negativeCount || missingUnitCount) {
    cards.push(warningCard('数据质量提示', notes.filter(n => /成本为 0|未设置默认售价|负库存|缺少基准单位/.test(n)).join('；')));
  }

  return ok({
    scope: { warehouse: scopeName, category: args.category || null, keyword: args.keyword || null },
    product_count: totals.products,
    by_dimension: byDimension,
    cost_value: totals.cost_value,
    retail_value: totals.retail_value,
    low_stock_count: lowStock,
    negative_count: negativeCount,
    zero_cost_with_stock_count: zeroCostCount,
    zero_sale_with_stock_count: zeroSaleCount,
    missing_unit_count: missingUnitCount,
    inactive_product_count: inactiveCount,
    top_by_value: top,
    by_category: byCategory
  }, { meta: { row_count: dimRows.length, source: 'stock/products/units' }, notes, cards });
}

function stockList(args = {}) {
  const scope = buildStockScope(args);
  if (scope.error) return scope.error;
  const limit = clampLimit(args.limit);
  const filters = [...scope.conditions];
  const params = [...scope.params];
  if (args.low_only) { filters.push('p.stock_low > 0 AND s.quantity < p.stock_low'); }
  if (args.negative_only) { filters.push('s.quantity < 0'); }
  const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM stock s JOIN products p ON p.id=s.product_id
    LEFT JOIN units u ON u.id=p.base_unit_id ${where}`).get(...params).c;
  const rows = db.prepare(`
    SELECT s.product_id, s.warehouse_id, s.quantity,
      p.name, p.sku, p.category, p.spec, p.base_unit_id, p.active,
      u.name AS unit_name, p.avg_cost, p.sale_price, p.stock_low, w.name AS warehouse_name,
      ROUND(s.quantity * COALESCE(p.weight_per_base_kg,0), 3) AS weight_kg,
      ROUND(s.quantity * p.avg_cost, 2) AS cost_value,
      ROUND(s.quantity * p.sale_price, 2) AS retail_value
    ${stockBase({ where })}
    ORDER BY p.category, p.name LIMIT ?`).all(...params, limit);

  const truncated = total > rows.length;
  const notes = [];
  if (!rows.length) notes.push('没有查到符合条件的库存记录');
  if (rows.some(r => r.active === 0)) notes.push('结果中包含已停用商品，请留意');
  if (truncated) notes.push(`仅显示前 ${rows.length} 条，共 ${total} 条；可以加关键词或仓库缩小范围`);
  const cardNote = notes.filter(n => n.startsWith('仅显示') || n.includes('已停用')).join('；');
  const cards = [tableCard(scope.wh.row ? `${scope.wh.row.name}库存明细` : '库存明细', [
    { prop: 'name', label: '商品' },
    { prop: 'warehouse_name', label: '仓库', width: 90 },
    { prop: 'quantity', label: '数量', format: 'qty' },
    { prop: 'unit_name', label: '单位', width: 60 },
    { prop: 'avg_cost', label: '平均成本', format: 'money' },
    { prop: 'cost_value', label: '库存金额', format: 'money' },
    { prop: 'stock_low', label: '低库存阈值', format: 'qty', width: 90 }
  ], rows, cardNote)];
  return ok({ rows }, { meta: { row_count: rows.length, total_count: total, truncated, source: 'stock' }, notes, cards });
}

function lowStock(args = {}) {
  const wh = resolveWarehouse(args.warehouse);
  if (wh.ambiguous) return fail('AMBIGUOUS', '仓库名称不唯一，请让用户选择', { candidates: wh.ambiguous.map(w => ({ id: w.id, name: w.name })) });
  if (wh.notFound) return fail('NOT_FOUND', `没有找到仓库「${args.warehouse}」`);
  const whId = wh.row ? wh.row.id : 0;
  const rows = db.prepare(`
    SELECT p.id, p.name, p.sku, p.category, p.stock_low, p.base_unit_id,
      u.name AS unit_name, COALESCE(SUM(s.quantity),0) AS qty,
      ROUND(p.stock_low - COALESCE(SUM(s.quantity),0), 3) AS gap
    FROM products p
    LEFT JOIN units u ON u.id=p.base_unit_id
    LEFT JOIN stock s ON s.product_id=p.id AND (?=0 OR s.warehouse_id=?)
    WHERE p.active=1 AND p.stock_low>0
    GROUP BY p.id HAVING qty < p.stock_low
    ORDER BY gap DESC LIMIT 100`).all(whId, whId);
  const truncated = rows.length >= 100;
  const notes = rows.length ? [] : ['当前没有低于库存阈值的商品'];
  if (truncated) notes.push('低库存商品超过 100 个，仅显示缺口最大的前 100 个');
  const cards = [tableCard(wh.row ? `${wh.row.name}低库存商品` : '低库存商品', [
    { prop: 'name', label: '商品' },
    { prop: 'category', label: '分类', width: 90 },
    { prop: 'qty', label: '当前结存', format: 'qty' },
    { prop: 'unit_name', label: '单位', width: 60 },
    { prop: 'stock_low', label: '阈值', format: 'qty', width: 70 },
    { prop: 'gap', label: '缺口', format: 'qty', width: 70 }
  ], rows, truncated ? notes[0] : '')];
  return ok({ rows }, { meta: { row_count: rows.length, truncated, source: 'stock/products' }, notes, cards });
}

function ledgerQuery(args = {}) {
  const wh = resolveWarehouse(args.warehouse);
  if (wh.ambiguous) return fail('AMBIGUOUS', '仓库名称不唯一，请让用户选择', { candidates: wh.ambiguous.map(w => ({ id: w.id, name: w.name })) });
  if (wh.notFound) return fail('NOT_FOUND', `没有找到仓库「${args.warehouse}」`);
  let productId = '';
  if (args.product) {
    const p = resolveProduct(args.product);
    if (p.ambiguous) return fail('AMBIGUOUS', '商品名称不唯一，请让用户选择', { candidates: p.ambiguous.map(x => ({ id: x.id, name: x.name, spec: x.spec })) });
    if (p.notFound) return fail('NOT_FOUND', `没有找到商品「${args.product}」`);
    productId = p.row.id;
  }
  const type = String(args.type || '');
  if (type && !TYPE_TEXT[type]) return fail('INVALID_ARG', 'type 必须是 purchase_in/sale_out/adjustment/reversal');
  const limit = clampLimit(args.limit);
  const where = `WHERE (?='' OR l.product_id=?) AND (?='' OR l.warehouse_id=?) AND (?='' OR l.type=?)
      AND (?='' OR date(l.created_at)>=?) AND (?='' OR date(l.created_at)<=?)`;
  const params = [
    productId, productId,
    wh.row ? wh.row.id : '', wh.row ? wh.row.id : '',
    type, type,
    args.from || '', args.from || '',
    args.to || '', args.to || ''
  ];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM stock_ledger l ${where}`).get(...params).c;
  const rows = db.prepare(`
    SELECT l.*, p.name AS product_name, p.sku AS product_sku, w.name AS warehouse_name, u.name AS unit_name
    FROM stock_ledger l
    JOIN products p ON p.id=l.product_id
    LEFT JOIN warehouses w ON w.id=l.warehouse_id
    LEFT JOIN units u ON u.id=l.unit_id
    ${where}
    ORDER BY l.id DESC LIMIT ?`).all(...params, limit);
  const truncated = total > rows.length;
  const notes = [];
  if (!rows.length) notes.push('没有查到符合条件的流水');
  if (truncated) notes.push(`仅显示最近 ${rows.length} 条，共 ${total} 条；可以加商品/仓库/日期缩小范围`);
  const cards = [tableCard('库存流水', [
    { prop: 'created_at', label: '时间', width: 145 },
    { prop: 'product_name', label: '商品' },
    { prop: 'warehouse_name', label: '仓库', width: 90 },
    { prop: 'type_text', label: '类型', width: 80 },
    { prop: 'change_qty', label: '变动', format: 'qty' },
    { prop: 'balance', label: '结存', format: 'qty' },
    { prop: 'ref_no', label: '单号', width: 140 }
  ], rows.map(r => ({ ...r, type_text: TYPE_TEXT[r.type] || r.type })), truncated ? notes[0] : '')];
  return ok({ rows }, { meta: { row_count: rows.length, total_count: total, truncated, source: 'stock_ledger' }, notes, cards });
}

function orderList(args = {}) {
  const kind = args.kind === 'purchase' ? 'purchase' : args.kind === 'sales' ? 'sales' : '';
  if (!kind) return fail('INVALID_ARG', 'kind 必须是 purchase 或 sales');
  const isPurchase = kind === 'purchase';
  const table = isPurchase ? 'purchase_orders' : 'sales_orders';
  const partnerCol = isPurchase ? 'o.supplier_id' : 'o.customer_id';
  const partnerJoin = isPurchase ? 'LEFT JOIN suppliers sp ON sp.id=o.supplier_id' : 'LEFT JOIN customers cu ON cu.id=o.customer_id';
  const partnerName = isPurchase ? 'sp.name AS partner_name' : 'cu.name AS partner_name';

  let partnerId = '';
  if (args.partner) {
    const p = resolvePartner(isPurchase ? 'supplier' : 'customer', args.partner);
    if (p.ambiguous) return fail('AMBIGUOUS', '往来单位名称不唯一，请让用户选择', { candidates: p.ambiguous.map(x => ({ id: x.id, name: x.name })) });
    if (p.notFound) return fail('NOT_FOUND', `没有找到${isPurchase ? '供应商' : '客户'}「${args.partner}」`);
    partnerId = p.row.id;
  }
  const status = ['done', 'voided'].includes(args.status) ? args.status : '';
  const limit = clampLimit(args.limit);
  const keyword = args.keyword ? `%${args.keyword}%` : '%';
  const where = `WHERE (?='' OR o.order_date>=?) AND (?='' OR o.order_date<=?)
      AND (?='' OR ${partnerCol}=?) AND (?='' OR o.status=?)
      AND (o.order_no LIKE ? OR o.remark LIKE ?)`;
  const params = [
    args.from || '', args.from || '',
    args.to || '', args.to || '',
    partnerId, partnerId,
    status, status,
    keyword, keyword
  ];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM ${table} o ${where}`).get(...params).c;
  const rows = db.prepare(`
    SELECT o.*, ${partnerName}, w.name AS warehouse_name,
      (SELECT COUNT(*) FROM ${isPurchase ? 'purchase_order_items' : 'sales_order_items'} i WHERE i.order_id=o.id) AS item_count
    FROM ${table} o ${partnerJoin}
    LEFT JOIN warehouses w ON w.id=o.warehouse_id
    ${where}
    ORDER BY o.id DESC LIMIT ?`).all(...params, limit);
  const truncated = total > rows.length;
  const notes = [];
  if (!rows.length) notes.push('没有查到符合条件的单据');
  if (truncated) notes.push(`仅显示最近 ${rows.length} 条，共 ${total} 条；可以加日期/往来单位/关键词缩小范围`);
  const cards = [tableCard(isPurchase ? '进货单' : '出货单', [
    { prop: 'order_no', label: '单号', width: 160 },
    { prop: 'order_date', label: '日期', width: 100 },
    { prop: 'partner_name', label: isPurchase ? '供应商' : '客户' },
    { prop: 'warehouse_name', label: '仓库', width: 90 },
    { prop: 'total_amount', label: '金额', format: 'money' },
    { prop: 'status_text', label: '状态', width: 70 },
    { prop: 'item_count', label: '明细数', format: 'int', width: 70 }
  ], rows.map(r => ({ ...r, status_text: r.status === 'voided' ? '已作废' : '已记账' })), truncated ? notes[0] : '')];
  return ok({ rows }, { meta: { row_count: rows.length, total_count: total, truncated, source: table }, notes, cards });
}

function orderDetail(args = {}) {
  const kind = args.kind === 'purchase' ? 'purchase' : args.kind === 'sales' ? 'sales' : '';
  if (!kind) return fail('INVALID_ARG', 'kind 必须是 purchase 或 sales');
  const isPurchase = kind === 'purchase';
  const table = isPurchase ? 'purchase_orders' : 'sales_orders';
  const itemTable = isPurchase ? 'purchase_order_items' : 'sales_order_items';
  const partnerJoin = isPurchase ? 'LEFT JOIN suppliers sp ON sp.id=o.supplier_id' : 'LEFT JOIN customers cu ON cu.id=o.customer_id';
  const partnerName = isPurchase ? 'sp.name AS partner_name' : 'cu.name AS partner_name';
  const where = args.id ? 'o.id=?' : 'o.order_no=?';
  const value = args.id || args.order_no;
  if (!value) return fail('INVALID_ARG', '需要 id 或 order_no');
  const order = db.prepare(`SELECT o.*, ${partnerName}, w.name AS warehouse_name FROM ${table} o ${partnerJoin} LEFT JOIN warehouses w ON w.id=o.warehouse_id WHERE ${where}`).get(value);
  if (!order) return fail('NOT_FOUND', '单据不存在');
  const items = db.prepare(`
    SELECT i.*, p.name AS product_name, p.spec AS product_spec, u.name AS unit_name
    FROM ${itemTable} i JOIN products p ON p.id=i.product_id LEFT JOIN units u ON u.id=i.unit_id
    WHERE i.order_id=? ORDER BY i.id`).all(order.id);
  const cards = [tableCard(`单据 ${order.order_no}`, [
    { prop: 'product_name', label: '商品' },
    { prop: 'product_spec', label: '规格', width: 80 },
    { prop: 'quantity', label: '数量', format: 'qty' },
    { prop: 'unit_name', label: '单位', width: 60 },
    { prop: 'unit_price', label: '单价', format: 'money' },
    { prop: 'amount', label: '金额', format: 'money' },
    { prop: 'remark', label: '备注' }
  ], items, `${order.partner_name || ''} · ${order.order_date} · ${order.warehouse_name || ''} · 合计 ¥${round(order.total_amount).toFixed(2)}${order.status === 'voided' ? ' · 已作废' : ''}`)];
  return ok({ order, items }, { meta: { row_count: items.length, source: itemTable }, cards });
}

function orderReport(kind, args = {}) {
  const isPurchase = kind === 'purchase';
  const orderTable = isPurchase ? 'purchase_orders' : 'sales_orders';
  const itemTable = isPurchase ? 'purchase_order_items' : 'sales_order_items';
  const partnerCol = isPurchase ? 'o.supplier_id' : 'o.customer_id';
  const partnerJoin = isPurchase ? 'LEFT JOIN suppliers sp ON sp.id=o.supplier_id' : 'LEFT JOIN customers cu ON cu.id=o.customer_id';
  const partnerName = isPurchase ? 'sp.name' : 'cu.name';
  const groupBy = ['product', 'partner', 'day'].includes(args.group_by) ? args.group_by : 'product';
  const groupCol = groupBy === 'partner' ? partnerName : groupBy === 'day' ? 'o.order_date' : 'p.name';
  const groupLabel = groupBy === 'partner' ? '往来单位' : groupBy === 'day' ? '日期' : '商品';

  let partnerId = '';
  if (args.partner) {
    const p = resolvePartner(isPurchase ? 'supplier' : 'customer', args.partner);
    if (p.ambiguous) return fail('AMBIGUOUS', '往来单位名称不唯一，请让用户选择', { candidates: p.ambiguous.map(x => ({ id: x.id, name: x.name })) });
    if (p.notFound) return fail('NOT_FOUND', '没有找到往来单位');
    partnerId = p.row.id;
  }
  let productId = '';
  if (args.product) {
    const p = resolveProduct(args.product);
    if (p.ambiguous) return fail('AMBIGUOUS', '商品名称不唯一，请让用户选择', { candidates: p.ambiguous.map(x => ({ id: x.id, name: x.name, spec: x.spec })) });
    if (p.notFound) return fail('NOT_FOUND', '没有找到商品');
    productId = p.row.id;
  }
  const rows = db.prepare(`
    SELECT ${groupCol} AS name, COUNT(DISTINCT o.id) AS order_count,
      ROUND(SUM(i.quantity_base), 3) AS qty_base,
      ROUND(SUM(i.quantity_base * COALESCE(p.weight_per_base_kg,0)), 3) AS weight_kg,
      ROUND(SUM(i.amount), 2) AS amount
    FROM ${itemTable} i
    JOIN ${orderTable} o ON o.id=i.order_id
    JOIN products p ON p.id=i.product_id
    ${partnerJoin}
    WHERE o.status='done'
      AND (?='' OR o.order_date>=?) AND (?='' OR o.order_date<=?)
      AND (?='' OR ${partnerCol}=?) AND (?='' OR i.product_id=?)
    GROUP BY ${groupCol} ORDER BY amount DESC LIMIT 500`).all(
    args.from || '', args.from || '',
    args.to || '', args.to || '',
    partnerId, partnerId,
    productId, productId
  );
  const total = rows.reduce((a, r) => ({ qty: a.qty + r.qty_base, weight: a.weight + r.weight_kg, amount: a.amount + r.amount }), { qty: 0, weight: 0, amount: 0 });
  const truncated = rows.length >= 500;
  const notes = ['仅统计未作废单据', '数量(基准) 是各商品基准单位数量之和，跨单位不可直接比较'];
  if (!rows.length) notes.push('该日期范围内没有数据');
  if (truncated) notes.push('仅显示前 500 条分组，请缩小日期范围或按商品/往来单位筛选');
  const cards = [tableCard(isPurchase ? '进货报表' : '出货报表', [
    { prop: 'name', label: groupLabel },
    { prop: 'order_count', label: '单数', format: 'int', width: 70 },
    { prop: 'qty_base', label: '数量(基准)', format: 'qty' },
    { prop: 'weight_kg', label: '重量kg', format: 'qty' },
    { prop: 'amount', label: '金额', format: 'money' }
  ], rows, `合计金额 ¥${round(total.amount).toFixed(2)}；仅统计未作废单据${truncated ? '；仅显示前 500 条分组' : ''}`)];
  return ok({ groupLabel, rows, total }, {
    meta: { row_count: rows.length, truncated, source: itemTable },
    notes,
    cards
  });
}

function profitReport(args = {}) {
  let productId = '';
  if (args.product) {
    const p = resolveProduct(args.product);
    if (p.ambiguous) return fail('AMBIGUOUS', '商品名称不唯一，请让用户选择', { candidates: p.ambiguous.map(x => ({ id: x.id, name: x.name, spec: x.spec })) });
    if (p.notFound) return fail('NOT_FOUND', '没有找到商品');
    productId = p.row.id;
  }
  let customerId = '';
  if (args.customer) {
    const c = resolvePartner('customer', args.customer);
    if (c.ambiguous) return fail('AMBIGUOUS', '客户名称不唯一，请让用户选择', { candidates: c.ambiguous.map(x => ({ id: x.id, name: x.name })) });
    if (c.notFound) return fail('NOT_FOUND', '没有找到客户');
    customerId = c.row.id;
  }
  const rows = db.prepare(`
    SELECT p.name, p.category,
      ROUND(SUM(i.quantity_base), 3) AS qty_base,
      ROUND(SUM(i.amount), 2) AS amount,
      ROUND(SUM(i.cost_amount), 2) AS cost,
      ROUND(SUM(i.amount - i.cost_amount), 2) AS profit
    FROM sales_order_items i
    JOIN sales_orders o ON o.id=i.order_id
    JOIN products p ON p.id=i.product_id
    WHERE o.status='done'
      AND (?='' OR o.order_date>=?) AND (?='' OR o.order_date<=?)
      AND (?='' OR i.product_id=?) AND (?='' OR o.customer_id=?)
    GROUP BY p.id ORDER BY profit DESC LIMIT 500`).all(
    args.from || '', args.from || '',
    args.to || '', args.to || '',
    productId, productId,
    customerId, customerId
  ).map(r => ({ ...r, rate: r.amount > 0 ? Math.round(r.profit / r.amount * 10000) / 100 : 0 }));
  const total = rows.reduce((a, r) => ({ amount: a.amount + r.amount, cost: a.cost + r.cost, profit: a.profit + r.profit, qty: a.qty + r.qty_base }), { amount: 0, cost: 0, profit: 0, qty: 0 });
  total.rate = total.amount > 0 ? Math.round(total.profit / total.amount * 10000) / 100 : 0;
  const truncated = rows.length >= 500;
  const notes = ['仅统计未作废单据', '成本为出库时结转的移动加权平均成本', '销量(基准) 是各商品基准单位数量之和，跨单位不可直接比较'];
  if (!rows.length) notes.push('该日期范围内没有数据');
  if (truncated) notes.push('仅显示前 500 条分组，请缩小日期范围或按商品/客户筛选');
  const cards = [tableCard('毛利报表', [
    { prop: 'name', label: '商品' },
    { prop: 'qty_base', label: '销量(基准)', format: 'qty' },
    { prop: 'amount', label: '销售额', format: 'money' },
    { prop: 'cost', label: '成本', format: 'money' },
    { prop: 'profit', label: '毛利', format: 'money' },
    { prop: 'rate', label: '毛利率%', format: 'qty' }
  ], rows, `合计：销售额 ¥${round(total.amount).toFixed(2)}，成本 ¥${round(total.cost).toFixed(2)}，毛利 ¥${round(total.profit).toFixed(2)}，毛利率 ${total.rate}%；仅统计未作废单据${truncated ? '；仅显示前 500 条分组' : ''}`)];
  return ok({ rows, total }, {
    meta: { row_count: rows.length, truncated, source: 'sales_order_items' },
    notes,
    cards
  });
}

function dashboardOverview() {
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
  const stats = {
    productCount: db.prepare('SELECT COUNT(*) c FROM products WHERE active=1').get().c,
    warehouseCount: db.prepare('SELECT COUNT(*) c FROM warehouses WHERE active=1').get().c,
    stockValue: db.prepare('SELECT ROUND(COALESCE(SUM(s.quantity * p.avg_cost),0),2) v FROM stock s JOIN products p ON p.id=s.product_id').get().v,
    todayPurchase: db.prepare("SELECT ROUND(COALESCE(SUM(total_amount),0),2) v FROM purchase_orders WHERE status='done' AND order_date=?").get(today).v,
    todaySales: db.prepare("SELECT ROUND(COALESCE(SUM(total_amount),0),2) v FROM sales_orders WHERE status='done' AND order_date=?").get(today).v,
    lowStockCount: db.prepare(`SELECT COUNT(*) c FROM (SELECT p.id FROM products p LEFT JOIN stock s ON s.product_id=p.id WHERE p.active=1 AND p.stock_low>0 GROUP BY p.id HAVING COALESCE(SUM(s.quantity),0) < p.stock_low)`).get().c
  };
  const from = db.prepare("SELECT date('now','localtime','-29 days') AS d").get().d;
  const pRows = db.prepare("SELECT order_date, SUM(total_amount) v FROM purchase_orders WHERE status='done' AND order_date>=? GROUP BY order_date").all(from);
  const sRows = db.prepare("SELECT order_date, SUM(total_amount) v FROM sales_orders WHERE status='done' AND order_date>=? GROUP BY order_date").all(from);
  const pMap = new Map(pRows.map(r => [r.order_date, r.v]));
  const sMap = new Map(sRows.map(r => [r.order_date, r.v]));
  const trend = [];
  for (let i = 29; i >= 0; i--) {
    const d = db.prepare(`SELECT date('now','localtime','-${i} days') AS d`).get().d;
    trend.push({ order_date: d, purchase: pMap.get(d) || 0, sales: sMap.get(d) || 0 });
  }
  const topStock = db.prepare(`
    SELECT p.name, ROUND(SUM(s.quantity * p.avg_cost),2) AS value
    FROM stock s JOIN products p ON p.id=s.product_id
    GROUP BY p.id ORDER BY value DESC LIMIT 10`).all();
  const recent = db.prepare(`
    SELECT l.*, p.name AS product_name, w.name AS warehouse_name
    FROM stock_ledger l JOIN products p ON p.id=l.product_id LEFT JOIN warehouses w ON w.id=l.warehouse_id
    ORDER BY l.id DESC LIMIT 10`).all().map(r => ({ ...r, type_text: TYPE_TEXT[r.type] || r.type }));

  const cards = [
    metricsCard('店铺概览', [
      intCard('商品数', stats.productCount),
      intCard('仓库数', stats.warehouseCount),
      moneyCard('库存总值(成本)', stats.stockValue),
      moneyCard('今日进货', stats.todayPurchase),
      moneyCard('今日出货', stats.todaySales),
      intCard('低库存商品', stats.lowStockCount)
    ], '注意：库存总值按成本口径；数量请用 stock_summary 分维度查询'),
    tableCard('库存金额 Top 10', [
      { prop: 'name', label: '商品' },
      { prop: 'value', label: '库存金额', format: 'money' }
    ], topStock)
  ];
  return ok({ stats, trend, topStock, recent }, {
    meta: { source: 'dashboard' },
    notes: [
      '仅统计未作废单据；库存金额按成本口径',
      '库存数量请用 stock_summary 分维度查询，不要使用原始 SUM(quantity) 作为“总库存”',
      '库存金额 Top 10 与最近流水均只各显示 10 条'
    ],
    cards
  });
}

// ---------- P2.1 经营分析（只读） ----------

function inventoryHealth(args = {}) {
  const wh = resolveWarehouse(args.warehouse);
  if (wh.ambiguous) return fail('AMBIGUOUS', '仓库名称不唯一，请让用户选择', { candidates: wh.ambiguous.map(w => ({ id: w.id, name: w.name })) });
  if (wh.notFound) return fail('NOT_FOUND', `没有找到仓库「${args.warehouse}」`);
  const whId = wh.row ? wh.row.id : 0;
  const slowDays = Math.min(Math.max(Number(args.slow_days) || 60, 7), 365);
  const limit = clampLimit(args.limit, 50);
  const cutoff = db.prepare(`SELECT date('now','localtime','-${slowDays} days') AS d`).get().d;

  const products = db.prepare(`
    SELECT p.id, p.name, p.category, p.spec, p.stock_low, p.avg_cost, p.sale_price,
      u.name AS unit_name,
      ROUND(COALESCE(SUM(s.quantity),0),3) AS qty,
      ROUND(COALESCE(SUM(s.quantity * p.avg_cost),0),2) AS cost_value,
      (SELECT MAX(o.order_date) FROM sales_order_items i
        JOIN sales_orders o ON o.id=i.order_id
        WHERE i.product_id=p.id AND o.status='done') AS last_sale
    FROM products p
    LEFT JOIN units u ON u.id=p.base_unit_id
    LEFT JOIN stock s ON s.product_id=p.id AND (?=0 OR s.warehouse_id=?)
    WHERE p.active=1
    GROUP BY p.id
    ORDER BY cost_value DESC`).all(whId, whId);

  const slowAll = products
    .filter(r => r.qty > 0 && (!r.last_sale || r.last_sale < cutoff))
    .sort((a, b) => b.cost_value - a.cost_value);
  const slow = slowAll.slice(0, limit);
  const negative = db.prepare(`
    SELECT p.name, p.category, w.name AS warehouse_name,
      ROUND(s.quantity,3) AS qty, u.name AS unit_name,
      ROUND(s.quantity * p.avg_cost,2) AS cost_value
    FROM stock s
    JOIN products p ON p.id=s.product_id
    JOIN warehouses w ON w.id=s.warehouse_id
    LEFT JOIN units u ON u.id=p.base_unit_id
    WHERE s.quantity < 0 AND p.active=1 AND (?=0 OR s.warehouse_id=?)
    ORDER BY s.quantity ASC LIMIT ?`).all(whId, whId, limit);
  const zeroCost = products.filter(r => r.qty > 0 && !Number(r.avg_cost))
    .sort((a, b) => b.cost_value - a.cost_value).slice(0, limit);
  const zeroSale = products.filter(r => r.qty > 0 && !Number(r.sale_price))
    .sort((a, b) => b.cost_value - a.cost_value).slice(0, limit);
  const lowRes = lowStock({ warehouse: args.warehouse });
  const lowRows = lowRes.ok ? lowRes.data.rows : [];

  const slowValue = round(slowAll.reduce((s, r) => s + r.cost_value, 0));
  const summary = {
    low_stock_count: lowRows.length,
    negative_count: negative.length,
    zero_cost_count: zeroCost.length,
    zero_sale_count: zeroSale.length,
    slow_moving_count: slowAll.length,
    slow_moving_value: slowValue,
    slow_days: slowDays
  };
  const scope = wh.row ? wh.row.name : '全部仓库';
  const cards = [metricsCard(`${scope}库存健康`, [
    intCard('低库存', summary.low_stock_count),
    intCard('负库存', summary.negative_count),
    intCard('零成本', summary.zero_cost_count),
    intCard('未设售价', summary.zero_sale_count),
    intCard('滞销商品', summary.slow_moving_count),
    moneyCard('滞销库存金额', slowValue)
  ], `滞销定义：有库存且最近 ${slowDays} 天没有销售记录`)];
  if (slow.length) {
    cards.push(tableCard(`${slowDays} 天未动销`, [
      { prop: 'name', label: '商品' },
      { prop: 'category', label: '分类', width: 80 },
      { prop: 'qty', label: '结存', format: 'qty' },
      { prop: 'unit_name', label: '单位', width: 55 },
      { prop: 'cost_value', label: '库存金额', format: 'money' },
      { prop: 'last_sale', label: '最后销售', width: 100 }
    ], slow.map(r => ({ ...r, last_sale: r.last_sale || '从未销售' }))));
  }
  if (negative.length) {
    cards.push(tableCard('负库存商品', [
      { prop: 'name', label: '商品' },
      { prop: 'warehouse_name', label: '仓库', width: 80 },
      { prop: 'qty', label: '结存', format: 'qty' },
      { prop: 'unit_name', label: '单位', width: 55 },
      { prop: 'cost_value', label: '库存金额', format: 'money' }
    ], negative));
  }
  if (zeroCost.length) {
    cards.push(tableCard('有库存但平均成本为 0', [
      { prop: 'name', label: '商品' },
      { prop: 'qty', label: '结存', format: 'qty' },
      { prop: 'unit_name', label: '单位', width: 55 },
      { prop: 'cost_value', label: '库存金额', format: 'money' }
    ], zeroCost));
  }
  if (zeroSale.length) {
    cards.push(tableCard('有库存但未设置售价', [
      { prop: 'name', label: '商品' },
      { prop: 'qty', label: '结存', format: 'qty' },
      { prop: 'unit_name', label: '单位', width: 55 },
      { prop: 'cost_value', label: '库存金额', format: 'money' }
    ], zeroSale));
  }
  if (lowRows.length) {
    cards.push(tableCard('低库存商品', [
      { prop: 'name', label: '商品' },
      { prop: 'qty', label: '当前结存', format: 'qty' },
      { prop: 'unit_name', label: '单位', width: 55 },
      { prop: 'stock_low', label: '阈值', format: 'qty', width: 65 },
      { prop: 'gap', label: '缺口', format: 'qty', width: 65 }
    ], lowRows));
  }

  const notes = [
    `滞销定义：有库存且最近 ${slowDays} 天没有销售记录`,
    '负库存是账实不符信号，必须提示',
    '零成本商品会让库存金额偏低；未设售价商品会让售价估算偏低',
    `数据时间 ${asOf()}，范围：${scope}，仅统计启用商品`
  ];
  if (slowAll.length > slow.length) notes.push(`滞销商品共 ${slowAll.length} 个，表格仅显示库存金额前 ${slow.length} 个`);
  if (negative.length >= limit) notes.push(`负库存记录超过 ${limit} 条，表格仅显示前 ${limit} 条`);
  return ok({ summary, slow_moving: slow, negative, zero_cost: zeroCost, zero_sale_price: zeroSale, low_stock: lowRows }, {
    meta: { row_count: slow.length + negative.length + zeroCost.length, source: 'stock/products/orders' },
    notes,
    cards
  });
}

function priceHistory(args = {}) {
  if (!args.product) return fail('INVALID_ARG', '请提供商品');
  const pr = resolveProduct(args.product);
  if (pr.ambiguous) return fail('AMBIGUOUS', '商品名称不唯一，请让用户选择', { candidates: pr.ambiguous.map(x => ({ id: x.id, name: x.name, spec: x.spec })) });
  if (pr.notFound) return fail('NOT_FOUND', `没有找到商品「${args.product}」`);
  let supplierId = '';
  if (args.supplier) {
    const sp = resolvePartner('supplier', args.supplier);
    if (sp.ambiguous) return fail('AMBIGUOUS', '供应商名称不唯一，请让用户选择', { candidates: sp.ambiguous.map(x => ({ id: x.id, name: x.name })) });
    if (sp.notFound) return fail('NOT_FOUND', `没有找到供应商「${args.supplier}」`);
    supplierId = sp.row.id;
  }
  const limit = clampLimit(args.limit, 30);
  const rows = db.prepare(`
    SELECT o.order_date, o.order_no, sp.name AS supplier_name,
      i.quantity, i.quantity_base, i.unit_price, i.amount,
      u.name AS unit_name, u.ratio AS unit_ratio
    FROM purchase_order_items i
    JOIN purchase_orders o ON o.id=i.order_id
    LEFT JOIN suppliers sp ON sp.id=o.supplier_id
    LEFT JOIN units u ON u.id=i.unit_id
    WHERE o.status='done' AND i.product_id=?
      AND (?='' OR o.supplier_id=?)
      AND (?='' OR o.order_date>=?) AND (?='' OR o.order_date<=?)
    ORDER BY o.order_date DESC, o.id DESC, i.id DESC LIMIT ?`).all(
    pr.row.id, supplierId, supplierId,
    args.from || '', args.from || '',
    args.to || '', args.to || '',
    limit
  ).map(r => ({
    ...r,
    base_price: round(Number(r.unit_price) / (Number(r.unit_ratio) || 1))
  }));

  const prices = rows.map(r => r.base_price);
  const summary = prices.length ? {
    count: prices.length,
    latest: prices[0],
    earliest: prices[prices.length - 1],
    min: Math.min(...prices),
    max: Math.max(...prices),
    avg: round(prices.reduce((s, n) => s + n, 0) / prices.length),
    change_pct: prices[prices.length - 1] > 0
      ? round((prices[0] - prices[prices.length - 1]) / prices[prices.length - 1] * 100, 2)
      : 0
  } : { count: 0 };
  const cards = [tableCard(`${pr.row.name} 历史进价`, [
    { prop: 'order_date', label: '日期', width: 100 },
    { prop: 'supplier_name', label: '供应商' },
    { prop: 'quantity', label: '数量', format: 'qty', width: 65 },
    { prop: 'unit_name', label: '单位', width: 55 },
    { prop: 'unit_price', label: '单价', format: 'money', width: 80 },
    { prop: 'base_price', label: '基准单价', format: 'money', width: 90 },
    { prop: 'order_no', label: '单号', width: 140 }
  ], rows, summary.count
    ? `最近 ¥${summary.latest}，最低 ¥${summary.min}，最高 ¥${summary.max}，较最早 ${summary.change_pct}%`
    : '没有查到进货记录')];
  const notes = [
    '基准单价 = 单价 ÷ 单位换算倍数，便于跨单位比较',
    '仅统计未作废进货单',
    `数据时间 ${asOf()}`
  ];
  return ok({ product: { id: pr.row.id, name: pr.row.name, spec: pr.row.spec || '' }, rows, summary }, {
    meta: { row_count: rows.length, source: 'purchase_order_items' },
    notes,
    cards
  });
}

function productMovement(args = {}) {
  if (!args.product) return fail('INVALID_ARG', '请提供商品');
  const pr = resolveProduct(args.product);
  if (pr.ambiguous) return fail('AMBIGUOUS', '商品名称不唯一，请让用户选择', { candidates: pr.ambiguous.map(x => ({ id: x.id, name: x.name, spec: x.spec })) });
  if (pr.notFound) return fail('NOT_FOUND', `没有找到商品「${args.product}」`);
  const wh = resolveWarehouse(args.warehouse);
  if (wh.ambiguous) return fail('AMBIGUOUS', '仓库名称不唯一，请让用户选择', { candidates: wh.ambiguous.map(w => ({ id: w.id, name: w.name })) });
  if (wh.notFound) return fail('NOT_FOUND', `没有找到仓库「${args.warehouse}」`);
  const whId = wh.row ? wh.row.id : 0;
  const from = args.from || db.prepare("SELECT date('now','localtime','-29 days') AS d").get().d;
  const to = args.to || todayStr();
  if (!validDate(from) || !validDate(to)) return fail('INVALID_ARG', '日期格式应为 YYYY-MM-DD');
  if (from > to) return fail('INVALID_ARG', '开始日期不能晚于结束日期');

  const opening = db.prepare(`
    SELECT ROUND(COALESCE(SUM(change_qty),0),3) AS q FROM stock_ledger
    WHERE product_id=? AND (?=0 OR warehouse_id=?) AND date(created_at) < ?`).get(pr.row.id, whId, whId, from).q;
  const byType = db.prepare(`
    SELECT type, ROUND(SUM(change_qty),3) AS qty, ROUND(SUM(amount),2) AS amount, COUNT(*) AS n
    FROM stock_ledger
    WHERE product_id=? AND (?=0 OR warehouse_id=?) AND date(created_at) BETWEEN ? AND ?
    GROUP BY type`).all(pr.row.id, whId, whId, from, to)
    .map(r => ({ ...r, type_text: TYPE_TEXT[r.type] || r.type }));
  const changes = round(byType.reduce((s, r) => s + r.qty, 0));
  const closing = round(opening + changes);
  const current = wh.row
    ? currentQty(pr.row.id, wh.row.id)
    : db.prepare('SELECT ROUND(COALESCE(SUM(quantity),0),3) AS q FROM stock WHERE product_id=?').get(pr.row.id).q;
  const typeQty = t => byType.find(r => r.type === t)?.qty || 0;
  const unit = pr.row.unit_name || '';
  const scope = wh.row ? wh.row.name : '全部仓库';
  const cards = [
    metricsCard(`${pr.row.name} 库存变动`, [
      qtyCard('期初', opening, unit),
      qtyCard('采购入库', typeQty('purchase_in'), unit),
      qtyCard('销售出库', typeQty('sale_out'), unit),
      qtyCard('库存调整', typeQty('adjustment'), unit),
      qtyCard('作废冲销', typeQty('reversal'), unit),
      qtyCard('期末', closing, unit),
      qtyCard('当前库存', current, unit)
    ], `${from} ~ ${to}，${scope}`),
    tableCard('按类型汇总', [
      { prop: 'type_text', label: '类型', width: 90 },
      { prop: 'n', label: '笔数', format: 'int', width: 60 },
      { prop: 'qty', label: '数量', format: 'qty' },
      { prop: 'amount', label: '金额', format: 'money' }
    ], byType)
  ];
  const notes = [
    '按库存流水的记账时间 created_at 统计；与单据 order_date 可能不同',
    '期末 = 期初 + 期间变动；若与当前库存不一致，说明期间外还有流水或数据异常'
  ];
  if (Number(current) !== Number(closing)) notes.push(`期末 ${closing} 与当前库存 ${current} 不一致，请核对`);
  return ok({
    product: { id: pr.row.id, name: pr.row.name, spec: pr.row.spec || '', unit_name: unit },
    warehouse: scope, from, to, opening, by_type: byType, closing, current_stock: current
  }, { meta: { row_count: byType.length, source: 'stock_ledger' }, notes, cards });
}

function partnerRanking(args = {}) {
  const kind = args.kind === 'supplier' ? 'supplier' : args.kind === 'customer' ? 'customer' : '';
  if (!kind) return fail('INVALID_ARG', 'kind 必须是 supplier 或 customer');
  const isSupplier = kind === 'supplier';
  const table = isSupplier ? 'purchase_orders' : 'sales_orders';
  const partnerTable = isSupplier ? 'suppliers' : 'customers';
  const col = isSupplier ? 'supplier_id' : 'customer_id';
  const limit = clampLimit(args.limit, 20);
  const rows = db.prepare(`
    SELECT pt.name, COUNT(DISTINCT o.id) AS order_count,
      ROUND(SUM(o.total_amount),2) AS amount
    FROM ${table} o JOIN ${partnerTable} pt ON pt.id=o.${col}
    WHERE o.status='done'
      AND (?='' OR o.order_date>=?) AND (?='' OR o.order_date<=?)
    GROUP BY pt.id ORDER BY amount DESC LIMIT ?`).all(
    args.from || '', args.from || '',
    args.to || '', args.to || '',
    limit
  );
  const total = round(rows.reduce((s, r) => s + r.amount, 0));
  const cards = [tableCard(isSupplier ? '供应商排名' : '客户排名', [
    { prop: 'name', label: '名称' },
    { prop: 'order_count', label: '单数', format: 'int', width: 70 },
    { prop: 'amount', label: '金额', format: 'money' }
  ], rows, `合计 ¥${total.toFixed(2)}；仅统计未作废单据`)];
  return ok({ kind, rows, total }, {
    meta: { row_count: rows.length, source: table },
    notes: ['仅统计未作废单据', rows.length ? '' : '该范围内没有数据'].filter(Boolean),
    cards
  });
}

function businessTrend(args = {}) {
  const kind = args.kind === 'purchase' ? 'purchase' : 'sales';
  const groupBy = ['day', 'week', 'month'].includes(args.group_by) ? args.group_by : 'day';
  const isSales = kind === 'sales';
  const table = isSales ? 'sales_orders' : 'purchase_orders';
  const itemTable = isSales ? 'sales_order_items' : 'purchase_order_items';
  const defaultFrom = groupBy === 'month' ? '-11 months' : groupBy === 'week' ? '-11 weeks' : '-29 days';
  const from = args.from || db.prepare(`SELECT date('now','localtime',?) AS d`).get(defaultFrom).d;
  const to = args.to || todayStr();
  if (!validDate(from) || !validDate(to)) return fail('INVALID_ARG', '日期格式应为 YYYY-MM-DD');
  if (from > to) return fail('INVALID_ARG', '开始日期不能晚于结束日期');

  const bucket = groupBy === 'day' ? 'o.order_date'
    : groupBy === 'week' ? "strftime('%Y-W%W', o.order_date)"
      : "substr(o.order_date,1,7)";
  const rows = db.prepare(`
    SELECT ${bucket} AS bucket,
      COUNT(DISTINCT o.id) AS order_count,
      ROUND(SUM(i.amount),2) AS amount,
      ${isSales ? 'ROUND(SUM(i.cost_amount),2) AS cost, ROUND(SUM(i.amount-i.cost_amount),2) AS profit' : '0 AS cost, 0 AS profit'}
    FROM ${itemTable} i JOIN ${table} o ON o.id=i.order_id
    WHERE o.status='done' AND o.order_date>=? AND o.order_date<=?
    GROUP BY bucket ORDER BY bucket`).all(from, to)
    .map(r => ({ ...r, rate: isSales && r.amount > 0 ? round(r.profit / r.amount * 100, 2) : 0 }));

  const total = rows.reduce((a, r) => ({
    order_count: a.order_count + r.order_count,
    amount: round(a.amount + r.amount),
    cost: round(a.cost + r.cost),
    profit: round(a.profit + r.profit)
  }), { order_count: 0, amount: 0, cost: 0, profit: 0 });
  total.rate = total.amount > 0 ? round(total.profit / total.amount * 100, 2) : 0;

  const columns = isSales ? [
    { prop: 'bucket', label: groupBy === 'day' ? '日期' : groupBy === 'week' ? '周' : '月份', width: 100 },
    { prop: 'order_count', label: '单数', format: 'int', width: 60 },
    { prop: 'amount', label: '销售额', format: 'money' },
    { prop: 'cost', label: '成本', format: 'money' },
    { prop: 'profit', label: '毛利', format: 'money' },
    { prop: 'rate', label: '毛利率%', format: 'qty' }
  ] : [
    { prop: 'bucket', label: groupBy === 'day' ? '日期' : groupBy === 'week' ? '周' : '月份', width: 100 },
    { prop: 'order_count', label: '单数', format: 'int', width: 60 },
    { prop: 'amount', label: '进货金额', format: 'money' }
  ];
  const note = isSales
    ? `合计：销售额 ¥${total.amount.toFixed(2)}，成本 ¥${total.cost.toFixed(2)}，毛利 ¥${total.profit.toFixed(2)}，毛利率 ${total.rate}%`
    : `合计进货金额 ¥${total.amount.toFixed(2)}`;
  const cards = [tableCard(isSales ? '销售/毛利趋势' : '进货趋势', columns, rows, `${from} ~ ${to}；${note}`)];
  return ok({ kind, group_by: groupBy, from, to, rows, total }, {
    meta: { row_count: rows.length, source: itemTable },
    notes: ['按单据日期统计，仅统计未作废单据', rows.length ? '' : '该日期范围内没有数据'].filter(Boolean),
    cards
  });
}

// ---------- 工具定义 ----------

const numOrString = { type: 'string' };

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'get_context',
      description: '获取当前店铺、仓库列表、计量单位、商品分类、单据数量和今天日期。回答任何问题前可先调用一次。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'resolve_entity',
      description: '按名称或 ID 查找商品/仓库/供应商/客户，返回候选。名称有歧义时先调用它，把候选列给用户选。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['warehouse', 'product', 'supplier', 'customer'], description: '实体类型' },
          query: { type: 'string', description: '名称、编号或 ID' }
        },
        required: ['type', 'query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'stock_summary',
      description: '查询仓库库存概览：按计量维度分组的数量、成本价值、售价估算、低库存/负库存/零成本商品数、库存价值 Top 10。回答“某仓库总共有多少库存/值多少钱”时优先用这个工具。',
      parameters: {
        type: 'object',
        properties: {
          warehouse: { ...numOrString, description: '仓库名称或 ID；不传表示全部仓库' },
          category: { type: 'string', description: '商品分类，可选' },
          keyword: { type: 'string', description: '商品名称/编号/条码关键词，可选' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'stock_list',
      description: '查询库存明细，支持按仓库、关键词、分类、低库存、负库存筛选。',
      parameters: {
        type: 'object',
        properties: {
          warehouse: { ...numOrString, description: '仓库名称或 ID，可选' },
          keyword: { type: 'string', description: '商品关键词，可选' },
          category: { type: 'string', description: '分类，可选' },
          low_only: { type: 'boolean', description: '只看低于库存阈值的商品' },
          negative_only: { type: 'boolean', description: '只看负库存' },
          limit: { type: 'integer', description: '最多返回行数，默认 50，最大 200' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'low_stock',
      description: '列出低于库存阈值的商品及缺口。',
      parameters: {
        type: 'object',
        properties: { warehouse: { ...numOrString, description: '仓库名称或 ID，可选' } },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ledger_query',
      description: '查询库存流水（采购入库/销售出库/库存调整/作废冲销），按时间倒序。',
      parameters: {
        type: 'object',
        properties: {
          product: { ...numOrString, description: '商品名称或 ID，可选' },
          warehouse: { ...numOrString, description: '仓库名称或 ID，可选' },
          type: { type: 'string', enum: ['purchase_in', 'sale_out', 'adjustment', 'reversal'], description: '流水类型，可选' },
          from: { type: 'string', description: '开始日期 YYYY-MM-DD，可选' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD，可选' },
          limit: { type: 'integer', description: '最多返回行数，默认 50，最大 200' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'order_list',
      description: '查询进货单或出货单列表。可按日期、往来单位、单号/备注、状态筛选。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['purchase', 'sales'], description: 'purchase=进货单，sales=出货单' },
          partner: { ...numOrString, description: '供应商/客户名称或 ID，可选' },
          from: { type: 'string', description: '开始日期 YYYY-MM-DD，可选' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD，可选' },
          keyword: { type: 'string', description: '单号或备注关键词，可选' },
          status: { type: 'string', enum: ['done', 'voided'], description: 'done=已记账，voided=已作废；不传表示全部' },
          limit: { type: 'integer', description: '最多返回行数，默认 50，最大 200' }
        },
        required: ['kind']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'order_detail',
      description: '查询一张进货单/出货单的表头和明细。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['purchase', 'sales'], description: 'purchase=进货单，sales=出货单' },
          id: { type: 'integer', description: '单据 ID，可选（与 order_no 二选一）' },
          order_no: { type: 'string', description: '单号，可选（与 id 二选一）' }
        },
        required: ['kind']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'purchase_report',
      description: '进货报表，可按商品/供应商/日期汇总。只统计未作废单据。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '开始日期 YYYY-MM-DD，可选' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD，可选' },
          group_by: { type: 'string', enum: ['product', 'partner', 'day'], description: '汇总维度，默认 product' },
          partner: { ...numOrString, description: '供应商名称或 ID，可选' },
          product: { ...numOrString, description: '商品名称或 ID，可选' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sales_report',
      description: '出货报表，可按商品/客户/日期汇总。只统计未作废单据。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '开始日期 YYYY-MM-DD，可选' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD，可选' },
          group_by: { type: 'string', enum: ['product', 'partner', 'day'], description: '汇总维度，默认 product' },
          partner: { ...numOrString, description: '客户名称或 ID，可选' },
          product: { ...numOrString, description: '商品名称或 ID，可选' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'profit_report',
      description: '毛利报表：销售额、成本、毛利、毛利率。只统计未作废单据，成本为出库时结转的移动加权平均成本。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '开始日期 YYYY-MM-DD，可选' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD，可选' },
          product: { ...numOrString, description: '商品名称或 ID，可选' },
          customer: { ...numOrString, description: '客户名称或 ID，可选' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dashboard_overview',
      description: '店铺概览：商品数、仓库数、库存总值(成本)、今日进货/出货、低库存数、近30天趋势、库存金额 Top 10、最近流水。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'inventory_health',
      description: '库存健康检查：低库存、负库存、零成本、未设售价、长期未动销（滞销）商品及库存金额。回答“哪些货压着卖不动/库存有什么问题”时用。',
      parameters: {
        type: 'object',
        properties: {
          warehouse: { ...numOrString, description: '仓库名称或 ID，可选' },
          slow_days: { type: 'integer', description: '滞销判定天数，默认 60，范围 7-365' },
          limit: { type: 'integer', description: '每类最多返回行数，默认 50，最大 200' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'price_history',
      description: '查询某商品的历史进货价，可按供应商和日期筛选；返回每次进货的单价与折算到基准单位的单价，用于判断香料价格波动。',
      parameters: {
        type: 'object',
        properties: {
          product: { ...numOrString, description: '商品名称或 ID' },
          supplier: { ...numOrString, description: '供应商名称或 ID，可选' },
          from: { type: 'string', description: '开始日期 YYYY-MM-DD，可选' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD，可选' },
          limit: { type: 'integer', description: '最多返回行数，默认 30，最大 200' }
        },
        required: ['product']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'product_movement',
      description: '查询某商品在指定期间的期初、采购入库、销售出库、库存调整、作废冲销、期末和当前库存。回答“这个月进了多少、出了多少、还剩多少”时用。',
      parameters: {
        type: 'object',
        properties: {
          product: { ...numOrString, description: '商品名称或 ID' },
          warehouse: { ...numOrString, description: '仓库名称或 ID，可选' },
          from: { type: 'string', description: '开始日期 YYYY-MM-DD，默认近 30 天' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD，默认今天' }
        },
        required: ['product']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'partner_ranking',
      description: '按金额对供应商或客户排名。回答“哪个供应商进货最多/哪个客户买得最多”时用。只统计未作废单据。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['supplier', 'customer'], description: 'supplier=供应商，customer=客户' },
          from: { type: 'string', description: '开始日期 YYYY-MM-DD，可选' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD，可选' },
          limit: { type: 'integer', description: '最多返回行数，默认 20，最大 200' }
        },
        required: ['kind']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'business_trend',
      description: '销售/进货趋势：按日/周/月汇总销售额、成本、毛利、毛利率或进货金额。回答“这个月每天卖了多少/近半年每月毛利”时用。只统计未作废单据。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['sales', 'purchase'], description: 'sales=销售趋势，purchase=进货趋势' },
          group_by: { type: 'string', enum: ['day', 'week', 'month'], description: '汇总粒度，默认 day' },
          from: { type: 'string', description: '开始日期 YYYY-MM-DD，可选；不传按粒度取近 30 天/12 周/12 月' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD，可选' }
        },
        required: []
      }
    }
  }
];

// 写工具只在用户授权「可记账」后加入模型可见的工具列表。
// 这些工具只生成待确认提案，不直接写库。
export const WRITE_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'propose_purchase_order',
      description: '生成一张待用户确认的进货单提案。只校验并返回预览，不写库；必须让用户在卡片上确认后才会真正创建。',
      parameters: {
        type: 'object',
        properties: {
          supplier: { type: 'string', description: '供应商名称或 ID；重名时先用 resolve_entity 查' },
          warehouse: { type: 'string', description: '仓库名称或 ID' },
          order_date: { type: 'string', description: '业务日期 YYYY-MM-DD；不传用今天' },
          remark: { type: 'string', description: '单据备注，可选' },
          items: {
            type: 'array',
            description: '商品明细，至少一条',
            items: {
              type: 'object',
              properties: {
                product: { type: 'string', description: '商品名称或 ID；重名时先用 resolve_entity 查' },
                unit: { type: 'string', description: '单位名称或 ID；不传用商品基准单位' },
                quantity: { type: 'number', description: '数量，必须大于 0' },
                unit_price: { type: 'number', description: '单价；不传用商品默认进价' },
                remark: { type: 'string', description: '行备注，可选' }
              },
              required: ['product', 'quantity']
            }
          }
        },
        required: ['supplier', 'warehouse', 'items']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_sales_order',
      description: '生成一张待用户确认的出货单提案。只校验库存并返回预览，不写库；必须让用户在卡片上确认后才会真正创建。',
      parameters: {
        type: 'object',
        properties: {
          customer: { type: 'string', description: '客户名称或 ID；重名时先用 resolve_entity 查' },
          warehouse: { type: 'string', description: '仓库名称或 ID' },
          order_date: { type: 'string', description: '业务日期 YYYY-MM-DD；不传用今天' },
          remark: { type: 'string', description: '单据备注，可选' },
          items: {
            type: 'array',
            description: '商品明细，至少一条',
            items: {
              type: 'object',
              properties: {
                product: { type: 'string', description: '商品名称或 ID；重名时先用 resolve_entity 查' },
                unit: { type: 'string', description: '单位名称或 ID；不传用商品基准单位' },
                quantity: { type: 'number', description: '数量，必须大于 0' },
                unit_price: { type: 'number', description: '单价；不传用商品默认售价' },
                remark: { type: 'string', description: '行备注，可选' }
              },
              required: ['product', 'quantity']
            }
          }
        },
        required: ['customer', 'warehouse', 'items']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_stock_adjustment',
      description: '生成一条待用户确认的库存调整（盘点）提案。只校验并返回预览，不写库；必须让用户在卡片上确认后才会真正调整。',
      parameters: {
        type: 'object',
        properties: {
          product: { type: 'string', description: '商品名称或 ID' },
          warehouse: { type: 'string', description: '仓库名称或 ID' },
          unit: { type: 'string', description: '单位名称或 ID；不传用商品基准单位' },
          delta_qty: { type: 'number', description: '增减数量，正数增加、负数减少，不能为 0' },
          reason: { type: 'string', description: '调整原因，必填（如：盘点、损耗）' }
        },
        required: ['product', 'warehouse', 'delta_qty', 'reason']
      }
    }
  }
];

export const DANGER_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'propose_void_order',
      description: '生成一张待用户确认的作废提案（进货单或出货单）。只校验并预览库存/成本影响，不写库；必须由用户在卡片上确认。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['purchase', 'sales'], description: 'purchase=进货单，sales=出货单' },
          id: { type: 'integer', description: '单据 ID，可选（与 order_no 二选一）' },
          order_no: { type: 'string', description: '单号，可选（与 id 二选一）' },
          reason: { type: 'string', description: '作废原因，必填' }
        },
        required: ['kind', 'reason']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_update_order',
      description: '生成一张待用户确认的改单提案。只校验并预览库存/成本影响，不写库；必须由用户在卡片上确认。不传 items 表示只改日期/备注/往来单位。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['purchase', 'sales'], description: 'purchase=进货单，sales=出货单' },
          id: { type: 'integer', description: '单据 ID，可选（与 order_no 二选一）' },
          order_no: { type: 'string', description: '单号，可选（与 id 二选一）' },
          order_date: { type: 'string', description: '新业务日期 YYYY-MM-DD，可选' },
          remark: { type: 'string', description: '新备注，可选' },
          supplier: { type: 'string', description: '新供应商名称/ID（仅进货单），可选' },
          customer: { type: 'string', description: '新客户名称/ID（仅出货单），可选' },
          items: {
            type: 'array',
            description: '新的完整明细；不传表示沿用原明细，只改表头',
            items: {
              type: 'object',
              properties: {
                product: { type: 'string', description: '商品名称或 ID' },
                unit: { type: 'string', description: '单位名称或 ID；不传用商品基准单位' },
                quantity: { type: 'number', description: '数量，必须大于 0' },
                unit_price: { type: 'number', description: '单价；不传用商品默认进价/售价' },
                remark: { type: 'string', description: '行备注，可选' }
              },
              required: ['product', 'quantity']
            }
          }
        },
        required: ['kind']
      }
    }
  }
];

export function toolDefsFor(level) {
  if (level === 'danger') return [...TOOL_DEFS, ...WRITE_TOOL_DEFS, ...DANGER_TOOL_DEFS];
  if (level === 'write') return [...TOOL_DEFS, ...WRITE_TOOL_DEFS];
  return TOOL_DEFS;
}

const HANDLERS = {
  get_context: getContext,
  resolve_entity: resolveEntity,
  stock_summary: stockSummary,
  stock_list: stockList,
  low_stock: lowStock,
  ledger_query: ledgerQuery,
  order_list: orderList,
  order_detail: orderDetail,
  purchase_report: (args) => orderReport('purchase', args),
  sales_report: (args) => orderReport('sales', args),
  profit_report: profitReport,
  dashboard_overview: dashboardOverview,
  inventory_health: inventoryHealth,
  price_history: priceHistory,
  product_movement: productMovement,
  partner_ranking: partnerRanking,
  business_trend: businessTrend,
  propose_purchase_order: proposePurchase,
  propose_sales_order: proposeSales,
  propose_stock_adjustment: proposeAdjustment,
  propose_void_order: proposeVoid,
  propose_update_order: proposeUpdate
};

export function executeTool(name, args = {}, context = {}) {
  const handler = HANDLERS[name];
  if (!handler) return { ok: false, code: 'UNKNOWN_TOOL', error: `未知工具：${name}` };
  try {
    const out = handler(args || {}, context || {});
    return out;
  } catch (e) {
    return { ok: false, code: 'DB_ERROR', error: `查询失败：${e.message}` };
  }
}