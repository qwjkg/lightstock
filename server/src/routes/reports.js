import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

function dateRange(req) {
  return { from: req.query.from || '', to: req.query.to || '' };
}

function round2(n) { return Math.round(n * 100) / 100; }

// 进货/出货报表：groupBy = product | partner | day
function buildOrderReport(kind) {
  const orderTable = kind === 'purchase' ? 'purchase_orders' : 'sales_orders';
  const itemTable = kind === 'purchase' ? 'purchase_order_items' : 'sales_order_items';
  const partnerCol = kind === 'purchase' ? 'sp.name' : 'cu.name';
  const partnerJoin = kind === 'purchase'
    ? 'LEFT JOIN suppliers sp ON sp.id=o.supplier_id'
    : 'LEFT JOIN customers cu ON cu.id=o.customer_id';
  const partnerFilter = kind === 'purchase' ? 'o.supplier_id' : 'o.customer_id';
  return (req, res) => {
    const { from, to } = dateRange(req);
    const partnerId = req.query.partnerId || '';
    const productId = req.query.productId || '';
    const groupBy = req.query.groupBy || 'product';
    const groupCol = groupBy === 'partner' ? partnerCol : groupBy === 'day' ? 'o.order_date' : 'p.name';
    const groupLabel = groupBy === 'partner' ? '往来单位' : groupBy === 'day' ? '日期' : '商品';
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
        AND (?='' OR ${partnerFilter}=?) AND (?='' OR i.product_id=?)
      GROUP BY ${groupCol} ORDER BY amount DESC LIMIT 500`).all(from, from, to, to, partnerId, partnerId, productId, productId);
    const total = rows.reduce((a, r) => ({ qty: a.qty + r.qty_base, weight: a.weight + r.weight_kg, amount: a.amount + r.amount }), { qty: 0, weight: 0, amount: 0 });
    res.json({ groupLabel, rows, total });
  };
}

router.get('/reports/purchase', buildOrderReport('purchase'));
router.get('/reports/sales', buildOrderReport('sales'));

router.get('/reports/profit', (req, res) => {
  const { from, to } = dateRange(req);
  const productId = req.query.productId || '';
  const customerId = req.query.customerId || '';
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
    GROUP BY p.id ORDER BY profit DESC LIMIT 500`).all(from, from, to, to, productId, productId, customerId, customerId);
  const total = rows.reduce((a, r) => ({ amount: a.amount + r.amount, cost: a.cost + r.cost, profit: a.profit + r.profit, qty: a.qty + r.qty_base }), { amount: 0, cost: 0, profit: 0, qty: 0 });
  total.rate = total.amount > 0 ? round2(total.profit / total.amount * 100) : 0;
  res.json({ rows, total });
});

router.get('/reports/dashboard', (req, res) => {
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
  const stats = {
    productCount: db.prepare('SELECT COUNT(*) c FROM products WHERE active=1').get().c,
    warehouseCount: db.prepare('SELECT COUNT(*) c FROM warehouses WHERE active=1').get().c,
    stockQty: db.prepare('SELECT ROUND(COALESCE(SUM(quantity),0),3) v FROM stock').get().v,
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
    ORDER BY l.id DESC LIMIT 20`).all();
  res.json({ stats, trend, topStock, recent });
});

export default router;
