import { db, round, now } from '../db.js';

// 数量归零的判定容差。成本池重放与 upsertStock 必须共用同一个阈值，
// 否则会出现「重放认为成本池里还有货、库存表认为已经归零」的分歧。
const EPS = 1e-6;

function getProduct(id) {
  return db.prepare('SELECT * FROM products WHERE id=?').get(id);
}
function getUnit(id) {
  return db.prepare('SELECT * FROM units WHERE id=?').get(id);
}
function getWarehouse(id) {
  return db.prepare('SELECT * FROM warehouses WHERE id=?').get(id);
}

function currentQty(productId, warehouseId) {
  const row = db.prepare('SELECT quantity FROM stock WHERE product_id=? AND warehouse_id=?').get(productId, warehouseId);
  return row ? row.quantity : 0;
}

function upsertStock(productId, warehouseId, delta) {
  const qty = round(currentQty(productId, warehouseId) + delta);
  // 只有精确归零才删行。负数必须如实落库：作废一张货已售出的采购单、
  // 或盘点调减超出实存，都会产生负库存，这是账实不符的信号，
  // 早期写法把负数一并当 0 处理，会把账面缺口悄悄抹平。
  if (Math.abs(qty) < EPS) {
    db.prepare('DELETE FROM stock WHERE product_id=? AND warehouse_id=?').run(productId, warehouseId);
    return 0;
  }
  db.prepare('INSERT INTO stock (product_id, warehouse_id, quantity) VALUES (?,?,?) ON CONFLICT(product_id, warehouse_id) DO UPDATE SET quantity=excluded.quantity')
    .run(productId, warehouseId, qty);
  return qty;
}

function addLedger(entry) {
  db.prepare(`INSERT INTO stock_ledger
    (product_id, warehouse_id, type, change_qty, change_qty_original, unit_id, unit_price, amount, cost_amount, balance, ref_type, ref_id, ref_no, remark)
    VALUES (@product_id, @warehouse_id, @type, @change_qty, @change_qty_original, @unit_id, @unit_price, @amount, @cost_amount, @balance, @ref_type, @ref_id, @ref_no, @remark)`)
    .run(entry);
}

// 移动加权平均成本：按流水入账顺序（id）重放，维护一个 (数量, 金额) 成本池。
//
// 不能用「全部采购总额 ÷ 全部采购数量」——那等于把已经卖出去那部分货物的历史
// 采购成本一直留在分母里。典型表现：1 月进 100 斤 @10 卖光，2 月进 100 斤 @20，
// 正确成本是 20，那种算法却算出 15。香料价格波动大，这个偏差会直接算进毛利。
//
// 重放规则：
//   采购入库 / 作废采购冲销：数量与金额同步进出成本池（冲销的 amount 是负数，正好抵消）
//   销售出库：按「当时的均价」结转成本；价格波动不在此刻改变均价
//   作废销售冲销：把当初结转的成本原样退回——cost_amount 自带符号，
//                 所以出库与冲销可以共用 amt -= cost_amount 一条规则
//   库存调整：按当时均价增减金额，因此不改变均价
//
// 成本池在库存归零（含因作废采购而变负）时清空，避免负池污染后续进货的均价。
//
// 传入 collect 时额外返回 ledgerFixes / saleCosts，供一次性历史迁移回填使用。
function replayLedger(productId, collect = false) {
  const rows = db.prepare(`SELECT id, type, change_qty, amount, cost_amount, ref_type, ref_id
    FROM stock_ledger WHERE product_id=? ORDER BY id`).all(productId);
  let qty = 0, amt = 0;
  const ledgerFixes = [];
  // 销售单 id -> { entries: [{cost, qty}], used }：同一张单里同一商品可能有多条明细，
  // 作废时按明细顺序一一对应取回当初结转的成本
  const saleCosts = new Map();
  for (const r of rows) {
    const avg = qty > EPS ? amt / qty : 0;
    if (r.type === 'sale_out') {
      const cost = round(avg * Math.abs(r.change_qty));
      const key = String(r.ref_id);
      if (!saleCosts.has(key)) saleCosts.set(key, { entries: [], used: 0 });
      saleCosts.get(key).entries.push({ cost, qty: Math.abs(r.change_qty) });
      amt -= cost; qty += r.change_qty;
      if (collect && Math.abs(cost - (r.cost_amount || 0)) > EPS) ledgerFixes.push({ id: r.id, cost });
    } else if (r.type === 'reversal' && r.ref_type === 'sales_order') {
      const entry = saleCosts.get(String(r.ref_id));
      const cost = entry && entry.used < entry.entries.length ? entry.entries[entry.used].cost : 0;
      if (entry) entry.used++;
      amt += cost; qty += r.change_qty;
      if (collect && Math.abs(-cost - (r.cost_amount || 0)) > EPS) ledgerFixes.push({ id: r.id, cost: -cost });
    } else if (r.type === 'adjustment') {
      amt += avg * r.change_qty; qty += r.change_qty;
    } else if (r.type === 'purchase_in' || (r.type === 'reversal' && r.ref_type === 'purchase_order')) {
      qty += r.change_qty; amt += r.amount || 0;
    } else {
      // 未知类型：只跟随数量，不动成本池
      qty += r.change_qty;
    }
    if (qty <= EPS) { qty = 0; amt = 0; }
  }
  return {
    avg: qty > EPS ? round(Math.max(0, amt / qty)) : 0,
    ledgerFixes,
    saleCosts
  };
}

// 供一次性历史迁移使用：返回重算后的均价与需要回填的成本金额
export function replayProductCost(productId) {
  return replayLedger(productId, true);
}

function recomputeAvgCost(productId) {
  const { avg } = replayLedger(productId);
  db.prepare('UPDATE products SET avg_cost=? WHERE id=?').run(avg, productId);
  return avg;
}

function today() {
  return db.prepare("SELECT date('now','localtime') AS d").get().d;
}

function nextOrderNo(prefix) {
  const d = today().replace(/-/g, '');
  const rows = db.prepare(`SELECT order_no FROM ${prefix === 'CG' ? 'purchase_orders' : 'sales_orders'} WHERE order_no LIKE ? ORDER BY order_no DESC LIMIT 1`).all(prefix + d + '%');
  const seq = rows.length ? parseInt(rows[0].order_no.slice(-4), 10) + 1 : 1;
  return `${prefix}${d}-${String(seq).padStart(4, '0')}`;
}

export function createPurchaseOrder(payload) {
  const run = db.transaction((p) => {
    if (!p.supplier_id || !p.warehouse_id) throw new Error('请选择供应商和仓库');
    if (!p.items || !p.items.length) throw new Error('请至少添加一条商品明细');
    if (!getSupplier(p.supplier_id)) throw new Error('供应商不存在');
    if (!getWarehouse(p.warehouse_id)) throw new Error('仓库不存在');
    const orderNo = nextOrderNo('CG');
    const info = db.prepare(`INSERT INTO purchase_orders (order_no, supplier_id, warehouse_id, order_date, remark, custom_data)
      VALUES (?,?,?,?,?,?)`).run(orderNo, p.supplier_id, p.warehouse_id, p.order_date || today(), p.remark || '', JSON.stringify(p.custom_data || {}));
    const orderId = info.lastInsertRowid;
    const insItem = db.prepare(`INSERT INTO purchase_order_items (order_id, product_id, unit_id, quantity, quantity_base, unit_price, amount, remark)
      VALUES (?,?,?,?,?,?,?,?)`);
    let total = 0;
    const touched = new Set();
    for (const it of p.items) {
      const product = getProduct(it.product_id);
      const unit = getUnit(it.unit_id);
      if (!product || !unit) throw new Error('商品或单位不存在');
      const quantity = Number(it.quantity) || 0;
      if (quantity <= 0) throw new Error('数量必须大于 0');
      const qtyBase = round(quantity * unit.ratio);
      const amount = round(quantity * (Number(it.unit_price) || 0));
      insItem.run(orderId, it.product_id, it.unit_id, quantity, qtyBase, it.unit_price || 0, amount, it.remark || '');
      const balance = upsertStock(it.product_id, p.warehouse_id, qtyBase);
      addLedger({
        product_id: it.product_id, warehouse_id: p.warehouse_id, type: 'purchase_in',
        change_qty: qtyBase, change_qty_original: quantity, unit_id: it.unit_id,
        unit_price: it.unit_price || 0, amount, cost_amount: amount, balance,
        ref_type: 'purchase_order', ref_id: orderId, ref_no: orderNo,
        remark: `采购入库 ${product.name}` + (it.remark ? '：' + it.remark : '')
      });
      touched.add(it.product_id);
      total += amount;
    }
    // 循环内不必逐条重算：重放读的是全量流水，结果只取决于最终状态，
    // 同一商品在一张单里有多条明细时只算一次即可。
    for (const pid of touched) recomputeAvgCost(pid);
    db.prepare('UPDATE purchase_orders SET total_amount=? WHERE id=?').run(round(total), orderId);
    return { id: Number(orderId), order_no: orderNo, total_amount: round(total) };
  });
  return run(payload);
}

export function createSalesOrder(payload) {
  const run = db.transaction((p) => {
    if (!p.customer_id || !p.warehouse_id) throw new Error('请选择客户和仓库');
    if (!p.items || !p.items.length) throw new Error('请至少添加一条商品明细');
    if (!getCustomer(p.customer_id)) throw new Error('客户不存在');
    if (!getWarehouse(p.warehouse_id)) throw new Error('仓库不存在');
    const orderNo = nextOrderNo('XS');
    const info = db.prepare(`INSERT INTO sales_orders (order_no, customer_id, warehouse_id, order_date, remark, custom_data)
      VALUES (?,?,?,?,?,?)`).run(orderNo, p.customer_id, p.warehouse_id, p.order_date || today(), p.remark || '', JSON.stringify(p.custom_data || {}));
    const orderId = info.lastInsertRowid;
    const insItem = db.prepare(`INSERT INTO sales_order_items (order_id, product_id, unit_id, quantity, quantity_base, unit_price, amount, cost_amount, remark)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    let total = 0;
    for (const it of p.items) {
      const product = getProduct(it.product_id);
      const unit = getUnit(it.unit_id);
      if (!product || !unit) throw new Error('商品或单位不存在');
      const quantity = Number(it.quantity) || 0;
      if (quantity <= 0) throw new Error('数量必须大于 0');
      const qtyBase = round(quantity * unit.ratio);
      const onHand = currentQty(it.product_id, p.warehouse_id);
      if (onHand + 1e-9 < qtyBase) {
        throw new Error(`库存不足：${product.name}（当前库存 ${round(onHand)}，出库需 ${qtyBase}）`);
      }
      const amount = round(quantity * (Number(it.unit_price) || 0));
      const costAmount = round((product.avg_cost || 0) * qtyBase);
      const balance = upsertStock(it.product_id, p.warehouse_id, -qtyBase);
      insItem.run(orderId, it.product_id, it.unit_id, quantity, qtyBase, it.unit_price || 0, amount, costAmount, it.remark || '');
      addLedger({
        product_id: it.product_id, warehouse_id: p.warehouse_id, type: 'sale_out',
        change_qty: -qtyBase, change_qty_original: -quantity, unit_id: it.unit_id,
        unit_price: it.unit_price || 0, amount, cost_amount: costAmount, balance,
        ref_type: 'sales_order', ref_id: orderId, ref_no: orderNo,
        remark: `销售出库 ${product.name}` + (it.remark ? '：' + it.remark : '')
      });
      total += amount;
    }
    db.prepare('UPDATE sales_orders SET total_amount=? WHERE id=?').run(round(total), orderId);
    return { id: Number(orderId), order_no: orderNo, total_amount: round(total) };
  });
  return run(payload);
}

// 冲销作废单据：反向入账，保留历史痕迹
export function voidOrder(kind, orderId) {
  const run = db.transaction(() => {
    const table = kind === 'purchase' ? 'purchase_orders' : 'sales_orders';
    const itemTable = kind === 'purchase' ? 'purchase_order_items' : 'sales_order_items';
    const order = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(orderId);
    if (!order) throw new Error('单据不存在');
    if (order.status !== 'done') throw new Error('单据已作废，不能重复操作');
    const items = db.prepare(`SELECT * FROM ${itemTable} WHERE order_id=?`).all(orderId);
    const touched = new Set();
    // 作废一张货已售出的采购单、或盘点调减超出实存，都会把库存压成负数。
    // 负数本身是如实记账（不再夹成 0），但必须让用户看见，
    // 否则就是换了一种方式「悄悄抹平账面缺口」。
    const negative = new Map();
    for (const it of items) {
      const sign = kind === 'purchase' ? -1 : 1;
      const qtyBase = round(it.quantity_base * sign);
      const balance = upsertStock(it.product_id, order.warehouse_id, qtyBase);
      if (balance < 0) negative.set(it.product_id, balance);
      else negative.delete(it.product_id);
      addLedger({
        product_id: it.product_id, warehouse_id: order.warehouse_id, type: 'reversal',
        change_qty: qtyBase, change_qty_original: round(it.quantity * sign), unit_id: it.unit_id,
        unit_price: it.unit_price, amount: round(-it.amount), cost_amount: round(-it.cost_amount), balance,
        ref_type: kind === 'purchase' ? 'purchase_order' : 'sales_order', ref_id: order.id, ref_no: order.order_no,
        remark: `作废${kind === 'purchase' ? '采购' : '销售'}单 ${order.order_no}`
      });
      if (kind === 'purchase') touched.add(it.product_id);
    }
    for (const pid of touched) recomputeAvgCost(pid);
    db.prepare(`UPDATE ${table} SET status='voided', voided_at=? WHERE id=?`).run(now(), orderId);
    return {
      id: orderId,
      negative: [...negative].map(([product_id, quantity]) => {
        const p = getProduct(product_id);
        return { product_id, quantity, name: p ? p.name : `#${product_id}` };
      })
    };
  });
  return run();
}

// 库存调整（盘点等）：type=adjustment
export function adjustStock(payload) {
  const run = db.transaction((p) => {
    const product = getProduct(p.product_id);
    const unit = getUnit(p.unit_id);
    if (!product) throw new Error('商品不存在');
    if (!p.warehouse_id || !getWarehouse(p.warehouse_id)) throw new Error('仓库不存在');
    const delta = Number(p.delta_qty) || 0;
    if (delta === 0) throw new Error('调整数量不能为 0');
    const ratio = unit ? unit.ratio : 1;
    const qtyBase = round(delta * ratio);
    const balance = upsertStock(p.product_id, p.warehouse_id, qtyBase);
    addLedger({
      product_id: p.product_id, warehouse_id: p.warehouse_id, type: 'adjustment',
      change_qty: qtyBase, change_qty_original: delta, unit_id: unit ? unit.id : null,
      unit_price: 0, amount: 0, cost_amount: 0, balance,
      ref_type: 'adjustment', ref_id: null, ref_no: '',
      remark: `库存调整 ${product.name}` + (p.remark ? '：' + p.remark : '')
    });
    return { id: p.product_id, balance };
  });
  return run(payload);
}

function getSupplier(id) { return db.prepare('SELECT * FROM suppliers WHERE id=?').get(id); }
function getCustomer(id) { return db.prepare('SELECT * FROM customers WHERE id=?').get(id); }

