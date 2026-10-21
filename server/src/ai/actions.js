import { createPurchaseOrder, createSalesOrder, adjustStock, voidOrder, updateOrder } from '../services/stock.js';

// 只负责“确认后真正执行”。校验和预览在 ai/tools.js 里完成；
// 这里复用现有 services/stock.js，保证库存、流水、成本一致性。
export function executeAction(record, resolved) {
  const type = record.action?.type;
  if (type === 'purchase_order') {
    const result = createPurchaseOrder(resolved);
    return {
      result,
      ref_type: 'purchase_order',
      ref_id: result.id,
      ref_no: result.order_no
    };
  }
  if (type === 'sales_order') {
    const result = createSalesOrder(resolved);
    return {
      result,
      ref_type: 'sales_order',
      ref_id: result.id,
      ref_no: result.order_no
    };
  }
  if (type === 'stock_adjustment') {
    const result = adjustStock(resolved);
    return {
      result: { ...result, product_id: resolved.product_id },
      ref_type: 'adjustment',
      ref_id: resolved.product_id,
      ref_no: ''
    };
  }
  if (type === 'void_order') {
    const result = voidOrder(resolved.kind, resolved.order_id);
    return {
      result: { ...result, order_no: record.action?.preview?.order_no || '' },
      ref_type: `${resolved.kind}_order`,
      ref_id: resolved.order_id,
      ref_no: record.action?.preview?.order_no || ''
    };
  }
  if (type === 'update_order') {
    const result = updateOrder(resolved.kind, resolved.order_id, resolved);
    return {
      result,
      ref_type: `${resolved.kind}_order`,
      ref_id: resolved.order_id,
      ref_no: result.order_no || record.action?.preview?.order_no || ''
    };
  }
  const err = new Error('未知的写操作类型');
  err.code = 'UNKNOWN_ACTION';
  throw err;
}