import { Router } from 'express';
import { db } from '../db.js';
import { createPurchaseOrder, createSalesOrder, voidOrder } from '../services/stock.js';

const router = Router();

function orderList(kind) {
  const table = kind === 'purchase' ? 'purchase_orders' : 'sales_orders';
  const itemTable = kind === 'purchase' ? 'purchase_order_items' : 'sales_order_items';
  const partnerJoin = kind === 'purchase'
    ? 'LEFT JOIN suppliers sp ON sp.id=o.supplier_id'
    : 'LEFT JOIN customers cu ON cu.id=o.customer_id';
  const partnerName = kind === 'purchase' ? 'sp.name AS partner_name' : 'cu.name AS partner_name';
  const partnerFilter = kind === 'purchase' ? "(?='' OR o.supplier_id=?)" : "(?='' OR o.customer_id=?)";
  return (req, res) => {
    const from = req.query.from || '';
    const to = req.query.to || '';
    const partnerId = req.query.partnerId || '';
    const keyword = req.query.keyword ? `%${req.query.keyword}%` : '%';
    const rows = db.prepare(`
      SELECT o.*, ${partnerName}, w.name AS warehouse_name,
        (SELECT COUNT(*) FROM ${itemTable} i WHERE i.order_id=o.id) AS item_count
      FROM ${table} o ${partnerJoin}
      LEFT JOIN warehouses w ON w.id=o.warehouse_id
      WHERE (?='' OR o.order_date>=?) AND (?='' OR o.order_date<=?)
        AND ${partnerFilter}
        AND (o.order_no LIKE ? OR o.remark LIKE ?)
      ORDER BY o.id DESC LIMIT 500`).all(from, from, to, to, partnerId, partnerId, keyword, keyword);
    res.json(rows);
  };
}

function orderDetail(kind) {
  const table = kind === 'purchase' ? 'purchase_orders' : 'sales_orders';
  const itemTable = kind === 'purchase' ? 'purchase_order_items' : 'sales_order_items';
  const partnerJoin = kind === 'purchase'
    ? 'LEFT JOIN suppliers sp ON sp.id=o.supplier_id'
    : 'LEFT JOIN customers cu ON cu.id=o.customer_id';
  const partnerName = kind === 'purchase' ? 'sp.name AS partner_name' : 'cu.name AS partner_name';
  return (req, res) => {
    const order = db.prepare(`SELECT o.*, ${partnerName}, w.name AS warehouse_name FROM ${table} o ${partnerJoin} LEFT JOIN warehouses w ON w.id=o.warehouse_id WHERE o.id=?`).get(req.params.id);
    if (!order) return res.status(404).json({ error: '单据不存在' });
    const items = db.prepare(`
      SELECT i.*, p.name AS product_name, p.spec AS product_spec, p.category AS product_category, u.name AS unit_name
      FROM ${itemTable} i JOIN products p ON p.id=i.product_id LEFT JOIN units u ON u.id=i.unit_id
      WHERE i.order_id=? ORDER BY i.id`).all(order.id);
    res.json({ ...order, items });
  };
}

// 开单提速用：某个往来单位的常卖商品 + 上次成交价。
// 不传 partnerId 时退化为「全店最近卖过的商品」，新客户第一次开单也有东西可点。
router.get('/order-suggest', (req, res) => {
  const kind = req.query.kind === 'purchase' ? 'purchase' : 'sales';
  const orderTable = kind === 'purchase' ? 'purchase_orders' : 'sales_orders';
  const itemTable = kind === 'purchase' ? 'purchase_order_items' : 'sales_order_items';
  const partnerCol = kind === 'purchase' ? 'supplier_id' : 'customer_id';
  const partnerId = String(req.query.partnerId || '');

  // 按该往来单位的出现频次排序；并列时看最近一次的时间
  const frequent = db.prepare(`
    SELECT i.product_id, p.name, p.spec, p.base_unit_id, u.name AS unit_name,
      COUNT(DISTINCT o.id) AS order_count,
      ROUND(SUM(i.quantity_base), 3) AS total_qty,
      MAX(o.order_date) AS last_date
    FROM ${itemTable} i
    JOIN ${orderTable} o ON o.id=i.order_id
    JOIN products p ON p.id=i.product_id AND p.active=1
    LEFT JOIN units u ON u.id=p.base_unit_id
    WHERE o.status='done' AND (?='' OR o.${partnerCol}=?)
    GROUP BY i.product_id
    ORDER BY order_count DESC, last_date DESC
    LIMIT 30`).all(partnerId, partnerId);

  // 每个商品在该往来单位名下的最后一次成交价与单位，用于带出历史价
  const lastRows = db.prepare(`
    SELECT product_id, unit_price, unit_id FROM (
      SELECT i.product_id, i.unit_price, i.unit_id,
        ROW_NUMBER() OVER (PARTITION BY i.product_id ORDER BY o.order_date DESC, o.id DESC) AS rn
      FROM ${itemTable} i JOIN ${orderTable} o ON o.id=i.order_id
      WHERE o.status='done' AND (?='' OR o.${partnerCol}=?)
    ) WHERE rn=1`).all(partnerId, partnerId);
  const lastMap = new Map(lastRows.map(r => [r.product_id, r]));

  res.json({
    products: frequent.map(r => {
      const last = lastMap.get(r.product_id);
      return {
        ...r,
        last_price: last ? last.unit_price : null,
        last_unit_id: last ? last.unit_id : null
      };
    })
  });
});

router.get('/purchase-orders', orderList('purchase'));
router.get('/purchase-orders/:id', orderDetail('purchase'));
router.post('/purchase-orders', (req, res) => {
  try { res.json(createPurchaseOrder(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/purchase-orders/:id/void', (req, res) => {
  try { res.json(voidOrder('purchase', Number(req.params.id))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/sales-orders', orderList('sales'));
router.get('/sales-orders/:id', orderDetail('sales'));
router.post('/sales-orders', (req, res) => {
  try { res.json(createSalesOrder(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/sales-orders/:id/void', (req, res) => {
  try { res.json(voidOrder('sales', Number(req.params.id))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

export default router;
