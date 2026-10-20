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

// 按明细记账（插入明细 + 写流水 + 更新库存）。新建和「修改单据」共用。
// 不自己开事务：调用方负责事务边界。
function insertOrderItems(kind, orderId, orderNo, warehouseId, items) {
  const isPurchase = kind === 'purchase';
  const insItem = db.prepare(isPurchase
    ? `INSERT INTO purchase_order_items (order_id, product_id, unit_id, quantity, quantity_base, unit_price, amount, remark)
       VALUES (?,?,?,?,?,?,?,?)`
    : `INSERT INTO sales_order_items (order_id, product_id, unit_id, quantity, quantity_base, unit_price, amount, cost_amount, remark)
       VALUES (?,?,?,?,?,?,?,?,?)`);
  let total = 0;
  const touched = new Set();
  for (const it of items) {
    const product = getProduct(it.product_id);
    const unit = getUnit(it.unit_id);
    if (!product || !unit) throw new Error('商品或单位不存在');
    const quantity = Number(it.quantity) || 0;
    if (quantity <= 0) throw new Error('数量必须大于 0');
    const qtyBase = round(quantity * unit.ratio);
    const amount = round(quantity * (Number(it.unit_price) || 0));
    if (isPurchase) {
      insItem.run(orderId, it.product_id, it.unit_id, quantity, qtyBase, it.unit_price || 0, amount, it.remark || '');
      const balance = upsertStock(it.product_id, warehouseId, qtyBase);
      addLedger({
        product_id: it.product_id, warehouse_id: warehouseId, type: 'purchase_in',
        change_qty: qtyBase, change_qty_original: quantity, unit_id: it.unit_id,
        unit_price: it.unit_price || 0, amount, cost_amount: amount, balance,
        ref_type: 'purchase_order', ref_id: orderId, ref_no: orderNo,
        remark: `采购入库 ${product.name}` + (it.remark ? '：' + it.remark : '')
      });
    } else {
      const onHand = currentQty(it.product_id, warehouseId);
      if (onHand + 1e-9 < qtyBase) {
        throw new Error(`库存不足：${product.name}（当前库存 ${round(onHand)}，出库需 ${qtyBase}）`);
      }
      const costAmount = round((product.avg_cost || 0) * qtyBase);
      const balance = upsertStock(it.product_id, warehouseId, -qtyBase);
      insItem.run(orderId, it.product_id, it.unit_id, quantity, qtyBase, it.unit_price || 0, amount, costAmount, it.remark || '');
      addLedger({
        product_id: it.product_id, warehouse_id: warehouseId, type: 'sale_out',
        change_qty: -qtyBase, change_qty_original: -quantity, unit_id: it.unit_id,
        unit_price: it.unit_price || 0, amount, cost_amount: costAmount, balance,
        ref_type: 'sales_order', ref_id: orderId, ref_no: orderNo,
        remark: `销售出库 ${product.name}` + (it.remark ? '：' + it.remark : '')
      });
    }
    touched.add(it.product_id);
    total += amount;
  }
  return { total: round(total), touched };
}

// 反向冲销一张单据的全部明细。作废和「修改单据」共用。
// reason 用于区分「作废」与「修改冲回」——用户在流水页要能分清。
function reverseOrderItems(kind, order, items, reason) {
  const isPurchase = kind === 'purchase';
  const sign = isPurchase ? -1 : 1;
  // 负数库存必须如实记账，但要让用户看见（见 voidOrder 的返回）
  const negative = new Map();
  for (const it of items) {
    const qtyBase = round(it.quantity_base * sign);
    const balance = upsertStock(it.product_id, order.warehouse_id, qtyBase);
    if (balance < 0) negative.set(it.product_id, balance);
    else negative.delete(it.product_id);
    addLedger({
      product_id: it.product_id, warehouse_id: order.warehouse_id, type: 'reversal',
      change_qty: qtyBase, change_qty_original: round(it.quantity * sign), unit_id: it.unit_id,
      unit_price: it.unit_price, amount: round(-it.amount), cost_amount: round(-it.cost_amount), balance,
      ref_type: isPurchase ? 'purchase_order' : 'sales_order', ref_id: order.id, ref_no: order.order_no,
      remark: reason
    });
  }
  return negative;
}

function negativeList(negative) {
  return [...negative].map(([product_id, quantity]) => {
    const p = getProduct(product_id);
    return { product_id, quantity, name: p ? p.name : `#${product_id}` };
  });
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
    const { total, touched } = insertOrderItems('purchase', orderId, orderNo, p.warehouse_id, p.items);
    // 循环内不必逐条重算：重放读的是全量流水，结果只取决于最终状态，
    // 同一商品在一张单里有多条明细时只算一次即可。
    for (const pid of touched) recomputeAvgCost(pid);
    db.prepare('UPDATE purchase_orders SET total_amount=? WHERE id=?').run(total, orderId);
    return { id: Number(orderId), order_no: orderNo, total_amount: total };
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
    const { total } = insertOrderItems('sales', orderId, orderNo, p.warehouse_id, p.items);
    db.prepare('UPDATE sales_orders SET total_amount=? WHERE id=?').run(total, orderId);
    return { id: Number(orderId), order_no: orderNo, total_amount: total };
  });
  return run(payload);
}

// 修改单据。按变更类型分流——只改备注/日期绝不能顺手把成本重估一遍。
//
// 明细有变化时走「红冲 + 重记」：
//   1. 把旧明细反向入账（但单据不标记作废）
//   2. 删除旧明细行（否则再作废时会重复冲销）
//   3. 先按红冲后的状态重算均价 —— 新销售的成本必须用这个值，
//      否则明细成本、流水成本、replayLedger 三处会各说各话，而毛利报表读的是明细成本
//   4. 按新明细重新记账
//   5. 收尾再重算一次（采购会改变均价）
//
// 已确认的取舍：采购单在货已售出之后被改价，不会重述历史毛利，
// 只影响当前库存成本。这种情况会返回 warning，前端必须展示。
export function updateOrder(kind, orderId, payload) {
  const run = db.transaction((p) => {
    const isPurchase = kind === 'purchase';
    const table = isPurchase ? 'purchase_orders' : 'sales_orders';
    const itemTable = isPurchase ? 'purchase_order_items' : 'sales_order_items';
    const partnerCol = isPurchase ? 'supplier_id' : 'customer_id';
    const order = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(orderId);
    if (!order) throw new Error('单据不存在');
    if (order.status !== 'done') throw new Error('已作废的单据不能修改');

    const oldItems = db.prepare(`SELECT * FROM ${itemTable} WHERE order_id=? ORDER BY id`).all(orderId);
    if (!p.items || !p.items.length) throw new Error('请至少添加一条商品明细');

    const partnerId = p[partnerCol] ?? order[partnerCol];
    // 本轮不支持改仓库：改仓要区分「移库」和「退货重卖」，语义不同，留到后续
    const warehouseId = order.warehouse_id;
    if (!(isPurchase ? getSupplier(partnerId) : getCustomer(partnerId))) {
      throw new Error(isPurchase ? '供应商不存在' : '客户不存在');
    }
    if (!getWarehouse(warehouseId)) throw new Error('仓库不存在');

    const orderDate = p.order_date || order.order_date;
    const remark = p.remark !== undefined ? p.remark : order.remark;
    const customData = JSON.stringify(p.custom_data !== undefined ? p.custom_data : JSON.parse(order.custom_data || '{}'));

    // 明细是否真的变了（商品/单位/数量/单价/行备注）
    const sig = rows => rows.map(r =>
      `${Number(r.product_id)}|${Number(r.unit_id)}|${Number(r.quantity)}|${Number(r.unit_price)}|${r.remark || ''}`
    ).join(';');
    const itemsChanged = sig(oldItems) !== sig(p.items);

    if (!itemsChanged) {
      // 只改表头：不写流水、不动成本
      db.prepare(`UPDATE ${table} SET ${partnerCol}=?, order_date=?, remark=?, custom_data=? WHERE id=?`)
        .run(partnerId, orderDate, remark, customData, orderId);
      return { id: orderId, order_no: order.order_no, itemsChanged: false, negative: [], warning: null };
    }

    // 采购单改价：若该单任一商品在最后一次入库之后发生过销售，历史毛利不会被重述
    let warning = null;
    if (isPurchase) {
      const pids = [...new Set([...oldItems.map(i => i.product_id), ...p.items.map(i => Number(i.product_id))])];
      const lastIn = db.prepare(`SELECT COALESCE(MAX(id),0) AS m FROM stock_ledger
        WHERE ref_type='purchase_order' AND ref_id=? AND type='purchase_in'`).get(orderId).m;
      const sold = pids.length
        ? db.prepare(`SELECT COUNT(*) AS c FROM stock_ledger
            WHERE type='sale_out' AND id > ? AND product_id IN (${pids.map(() => '?').join(',')})`).get(lastIn, ...pids).c
        : 0;
      if (sold > 0) {
        warning = '这批货已经卖出过一部分，修改进价或数量不会重算过去已结转的毛利，只影响当前库存成本。';
      }
    }

    // 1) 红冲旧明细
    reverseOrderItems(kind, order, oldItems, `修改冲回 ${order.order_no}`);
    // 2) 删除旧明细（关键：保证当前明细与最后一版流水一一对应）
    db.prepare(`DELETE FROM ${itemTable} WHERE order_id=?`).run(orderId);
    // 3) 先按红冲后的状态重算均价
    const touched = new Set([...oldItems.map(i => i.product_id), ...p.items.map(i => Number(i.product_id))]);
    for (const pid of touched) recomputeAvgCost(pid);
    // 4) 更新表头
    db.prepare(`UPDATE ${table} SET ${partnerCol}=?, order_date=?, remark=?, custom_data=? WHERE id=?`)
      .run(partnerId, orderDate, remark, customData, orderId);
    // 5) 按新明细重新记账
    const { total } = insertOrderItems(kind, orderId, order.order_no, warehouseId, p.items);
    // 6) 收尾重算
    for (const pid of touched) recomputeAvgCost(pid);
    db.prepare(`UPDATE ${table} SET total_amount=? WHERE id=?`).run(total, orderId);

    // 采购单改小数量可能让库存变负，如实返回
    const negative = new Map();
    for (const pid of touched) {
      const q = currentQty(pid, warehouseId);
      if (q < 0) negative.set(pid, q);
    }
    return { id: orderId, order_no: order.order_no, itemsChanged: true, total_amount: total, negative: negativeList(negative), warning };
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
    // 显式 ORDER BY id：保存和作废必须按同一顺序处理明细，
    // 否则同一商品多行时 replayLedger 的成本队列会对不齐
    const items = db.prepare(`SELECT * FROM ${itemTable} WHERE order_id=? ORDER BY id`).all(orderId);
    const negative = reverseOrderItems(kind, order, items, `作废${kind === 'purchase' ? '采购' : '销售'}单 ${order.order_no}`);
    // 采购和销售都要重算：作废销售后成本池的构成变了，均价可能不再是原值
    for (const pid of new Set(items.map(i => i.product_id))) recomputeAvgCost(pid);
    db.prepare(`UPDATE ${table} SET status='voided', voided_at=? WHERE id=?`).run(now(), orderId);
    return { id: orderId, negative: negativeList(negative) };
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

