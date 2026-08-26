import { db, round, now } from '../db.js';

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
  if (qty <= 0.000001) {
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

// 移动加权平均成本：全部采购入账（含作废采购的负数冲销）的 总金额/总数量
function recomputeAvgCost(productId) {
  const rows = db.prepare(`
    SELECT change_qty, amount FROM stock_ledger
    WHERE product_id=? AND (type='purchase_in' OR (type='reversal' AND ref_type='purchase_order'))
  `).all(productId);
  let totalQty = 0, totalCost = 0;
  for (const r of rows) {
    totalQty += r.change_qty;
    totalCost += r.amount || 0;
  }
  const avg = totalQty > 0.000001 ? totalCost / totalQty : 0;
  db.prepare('UPDATE products SET avg_cost=? WHERE id=?').run(round(avg), productId);
  return round(avg);
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
      recomputeAvgCost(it.product_id);
      total += amount;
    }
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
    for (const it of items) {
      const sign = kind === 'purchase' ? -1 : 1;
      const qtyBase = round(it.quantity_base * sign);
      const balance = upsertStock(it.product_id, order.warehouse_id, qtyBase);
      addLedger({
        product_id: it.product_id, warehouse_id: order.warehouse_id, type: 'reversal',
        change_qty: qtyBase, change_qty_original: round(it.quantity * sign), unit_id: it.unit_id,
        unit_price: it.unit_price, amount: round(-it.amount), cost_amount: round(-it.cost_amount), balance,
        ref_type: kind === 'purchase' ? 'purchase_order' : 'sales_order', ref_id: order.id, ref_no: order.order_no,
        remark: `作废${kind === 'purchase' ? '采购' : '销售'}单 ${order.order_no}`
      });
      if (kind === 'purchase') recomputeAvgCost(it.product_id);
    }
    db.prepare(`UPDATE ${table} SET status='voided', voided_at=? WHERE id=?`).run(now(), orderId);
    return { id: orderId };
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

