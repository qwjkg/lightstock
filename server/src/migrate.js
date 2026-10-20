import { db, getSetting, setSetting, round } from './db.js';
import { replayProductCost } from './services/stock.js';
import { createBackupFile } from './routes/system.js';

// 一次性迁移：把历史上按旧算法记下的成本改用移动加权平均重算。
//
// 旧算法是「全历史采购总额 ÷ 全历史采购数量」，会把已经卖出那部分货物的
// 历史采购成本一直留在分母里，导致商品卖光后再进货时成本被历史低价稀释、
// 毛利虚高。新算法按流水顺序重放（见 services/stock.js 的 replayLedger）。
//
// 迁移会同时改写 stock_ledger.cost_amount 和 sales_order_items.cost_amount，
// 所以「历史毛利报表的数字会变化」——这是有意的修正，不是数据损坏。
// 迁移前自动备份到 server/data/backups/，需要回滚时用备份覆盖 warehouse.db 即可。
//
// 幂等：只依赖流水本身和固定算法，跑到一半中断可以直接重跑；
// 完成后写 settings.cost_algo_v2='1'，之后启动会直接跳过。
export async function migrateCostV2() {
  if (getSetting('cost_algo_v2', '') === '1') return null;

  // 先备份再动数据。备份失败就中止，不冒「改坏了又没得回滚」的风险。
  await createBackupFile();

  const products = db.prepare('SELECT id FROM products').all();
  const updAvg = db.prepare('UPDATE products SET avg_cost=? WHERE id=?');
  const fixLedger = db.prepare('UPDATE stock_ledger SET cost_amount=? WHERE id=?');
  const fixItem = db.prepare('UPDATE sales_order_items SET cost_amount=? WHERE id=?');
  const itemsOf = db.prepare('SELECT id, quantity_base FROM sales_order_items WHERE order_id=? AND product_id=? ORDER BY id');

  const stat = { products: 0, ledgerRows: 0, itemRows: 0, noCostSales: 0 };

  // 整库重放 + 回填 + 置标志位放在同一个事务里，
  // 杜绝「标志已写、数据只改了一半」的崩溃窗口。
  const run = db.transaction(() => {
    for (const p of products) {
      const { avg, ledgerFixes, saleCosts } = replayProductCost(p.id);
      updAvg.run(avg, p.id);
      stat.products++;

      for (const fix of ledgerFixes) { fixLedger.run(fix.cost, fix.id); stat.ledgerRows++; }

      for (const [orderId, entry] of saleCosts) {
        const items = itemsOf.all(Number(orderId), p.id);
        if (!items.length || !entry.entries.length) continue;
        const costSum = round(entry.entries.reduce((s, e) => s + e.cost, 0));
        const qtySum = round(entry.entries.reduce((s, e) => s + e.qty, 0));
        if (costSum === 0) stat.noCostSales++;
        if (qtySum <= 0) continue;
        // 同一张出库单里均价是恒定的，所以按 quantity_base 比例摊到各明细是精确的，
        // 这样同一商品在一张单里有多条明细时也不会摊错。
        const perBase = costSum / qtySum;
        for (const it of items) { fixItem.run(round(perBase * it.quantity_base), it.id); stat.itemRows++; }
      }
    }
    setSetting('cost_algo_v2', '1');
  });
  run();

  return stat;
}