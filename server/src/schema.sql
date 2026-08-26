-- 单位（计量体系）
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  dimension TEXT NOT NULL DEFAULT 'count',
  ratio REAL NOT NULL DEFAULT 1,
  weight_per REAL,
  is_base INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 商品
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sku TEXT DEFAULT '',
  barcode TEXT DEFAULT '',
  category TEXT DEFAULT '',
  spec TEXT DEFAULT '',
  base_unit_id INTEGER REFERENCES units(id),
  weight_per_base_kg REAL NOT NULL DEFAULT 0,
  purchase_price REAL NOT NULL DEFAULT 0,
  sale_price REAL NOT NULL DEFAULT 0,
  stock_low REAL NOT NULL DEFAULT 0,
  avg_cost REAL NOT NULL DEFAULT 0,
  remark TEXT DEFAULT '',
  custom_data TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

-- 供应商
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  contact TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  custom_data TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 客户
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  contact TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  custom_data TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 仓库（多仓库）
CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  code TEXT DEFAULT '',
  address TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 采购入库单
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  order_date TEXT NOT NULL,
  total_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'done',
  remark TEXT DEFAULT '',
  custom_data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  voided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_po_date ON purchase_orders(order_date);
CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  unit_id INTEGER NOT NULL REFERENCES units(id),
  quantity REAL NOT NULL,
  quantity_base REAL NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  remark TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_poi_order ON purchase_order_items(order_id);

-- 销售出库单
CREATE TABLE IF NOT EXISTS sales_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  order_date TEXT NOT NULL,
  total_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'done',
  remark TEXT DEFAULT '',
  custom_data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  voided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_so_date ON sales_orders(order_date);
CREATE INDEX IF NOT EXISTS idx_so_customer ON sales_orders(customer_id);

CREATE TABLE IF NOT EXISTS sales_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  unit_id INTEGER NOT NULL REFERENCES units(id),
  quantity REAL NOT NULL,
  quantity_base REAL NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  cost_amount REAL NOT NULL DEFAULT 0,
  remark TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_soi_order ON sales_order_items(order_id);

-- 库存（当前结存，基准单位）
CREATE TABLE IF NOT EXISTS stock (
  product_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, warehouse_id)
);

-- 库存流水（进销存的账本核心）
CREATE TABLE IF NOT EXISTS stock_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  change_qty REAL NOT NULL,
  change_qty_original REAL NOT NULL DEFAULT 0,
  unit_id INTEGER,
  unit_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  cost_amount REAL NOT NULL DEFAULT 0,
  balance REAL NOT NULL DEFAULT 0,
  ref_type TEXT DEFAULT '',
  ref_id INTEGER,
  ref_no TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_product ON stock_ledger(product_id);
CREATE INDEX IF NOT EXISTS idx_ledger_warehouse ON stock_ledger(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON stock_ledger(created_at);

-- 自定义字段定义
CREATE TABLE IF NOT EXISTS custom_field_defs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL,
  options TEXT DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cfd_entity_name ON custom_field_defs(entity, name);

-- 系统设置
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);
