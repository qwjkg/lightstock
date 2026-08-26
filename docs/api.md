# API 接口清单（前端与三端扩展共用的契约）

统一前缀 `/api`，JSON 交互；设置了访问密码时需 `Authorization: Bearer <token>`（`POST /api/login` 获取）。

## 基础资料
| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | /units | 单位列表/新增（name, dimension: count/weight, ratio, weight_per, sort_order） |
| PUT/DELETE | /units/:id | 编辑/停用单位 |
| GET | /products | 商品列表（keyword/category 筛选，含库存、单位名） |
| POST/PUT/DELETE | /products(/:id) | 商品增改停用（含 custom_data 自定义字段值） |
| GET | /products/categories | 分类列表 |
| GET/POST | /suppliers(/:id), /customers(/:id) | 供应商/客户增改查停用 |
| GET/POST | /warehouses(/:id) | 仓库增改查停用 |
| GET/POST/PUT/DELETE | /custom-fields(/:id) | 自定义字段定义（entity: product/supplier/customer/purchase_order/sales_order） |

## 单据
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /purchase-orders | 列表（from/to/partnerId/keyword） |
| GET | /purchase-orders/:id | 详情（含明细） |
| POST | /purchase-orders | 新建（supplier_id, warehouse_id, order_date, remark, custom_data, items[]） |
| POST | /purchase-orders/:id/void | 作废冲销（库存自动回退） |
| GET/POST | /sales-orders(/:id) | 出货单同构（customer_id） |

items 元素：`{ product_id, unit_id, quantity, unit_price, remark }`，quantity 按所选单位录入，后端按 ratio 折算基准单位并校验。

## 库存与流水
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /stock | 当前库存（warehouseId/productId/keyword/lowOnly） |
| GET | /stock/low | 低库存商品 |
| POST | /stock/adjust | 库存调整（product_id, warehouse_id, unit_id, delta_qty, remark） |
| GET | /ledger | 库存流水（productId/warehouseId/type/from/to/keyword） |

## 报表与仪表盘
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /reports/purchase, /reports/sales | 进/出货报表（groupBy: product/partner/day） |
| GET | /reports/profit | 毛利报表（销售额/成本/毛利/毛利率，可按商品） |
| GET | /reports/dashboard | 仪表盘统计数据 |

## 系统
| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | /settings | 读取/保存设置（business_name, auto_backup_hours, access_password） |
| POST | /login | 密码登录换取 token |
| POST/GET | /backups(/:id) | 立即备份 / 备份列表 / 下载 |
| POST | /import/products | 商品批量导入（rows: 前端 xlsx 解析后的 JSON） |
| GET | /export/* | Excel 导出（products/stock/purchase/sales/ledger/profit） |
