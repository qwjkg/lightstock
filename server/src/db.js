import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 数据目录默认在 server/data。允许用环境变量指到别处：
// 便于在含真实数据的机器上跑测试（test/*.js 会删库/写测试数据），
// 也便于把账本放到别的盘或同步盘。
export const dataDir = process.env.LIGHTSTOCK_DATA_DIR
  ? path.resolve(process.env.LIGHTSTOCK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
export const DB_PATH = path.join(dataDir, 'warehouse.db');

// db 用 let 导出：备份恢复时需要关闭连接、替换文件、再重新打开。
// 其它模块 import 的是活的绑定，重开后自动指向新连接。
export let db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// 数据库文件被替换后调用：重新打开连接并确保基础结构存在。
// 调用方负责先 db.close() 并替换好文件。
export function reopenDb() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  return db;
}

// 首次初始化：默认单位、默认仓库、默认设置
const unitCount = db.prepare('SELECT COUNT(*) AS c FROM units').get().c;
if (unitCount === 0) {
  const ins = db.prepare('INSERT INTO units (name, dimension, ratio, is_base, sort_order) VALUES (?,?,?,?,?)');
  ins.run('件', 'count', 1, 1, 1);
  ins.run('箱', 'count', 24, 0, 2);
  ins.run('打', 'count', 12, 0, 3);
  ins.run('公斤', 'weight', 1, 1, 4);
  ins.run('斤', 'weight', 0.5, 0, 5);
  ins.run('克', 'weight', 0.001, 0, 6);
  ins.run('吨', 'weight', 1000, 0, 7);
}
// 「斤」是香料、干货铺子的常用计价单位，早期的默认单位表里没有，
// 老库升级时补上。已经有同名单位（哪怕被停用）就不再插，
// 免得用户特意删掉之后每次启动又被加回来。
if (!db.prepare('SELECT 1 FROM units WHERE name=?').get('斤')) {
  db.prepare('UPDATE units SET sort_order = sort_order + 1 WHERE sort_order >= ?').run(5);
  db.prepare('INSERT INTO units (name, dimension, ratio, is_base, sort_order) VALUES (?,?,?,?,?)')
    .run('斤', 'weight', 0.5, 0, 5);
}
const whCount = db.prepare('SELECT COUNT(*) AS c FROM warehouses').get().c;
if (whCount === 0) {
  db.prepare("INSERT INTO warehouses (name, code) VALUES ('主仓库', 'WH01')").run();
}
const stCount = db.prepare('SELECT COUNT(*) AS c FROM settings').get().c;
if (stCount === 0) {
  const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?,?)');
  ins.run('business_name', '我的店铺');
  ins.run('access_password', '');
  ins.run('auto_backup_hours', '6');
}

// 界面模式与引导状态只在这里一次性落定，之后不再随业务数据增减而变。
// 注意：这两个键必须「选定即固化」。早期的写法是在 GET /settings 里按
// 「库里有没有业务数据」现算，结果用户录入第一个商品时，界面会自己从
// 简易模式跳成高级模式——正好抵消了简化这件事。空库默认简易，老库默认高级。
function hasBusinessData() {
  return db.prepare('SELECT COUNT(*) AS c FROM products').get().c > 0
    || db.prepare('SELECT COUNT(*) AS c FROM purchase_orders').get().c > 0
    || db.prepare('SELECT COUNT(*) AS c FROM sales_orders').get().c > 0;
}
const hasSetting = key => !!db.prepare('SELECT 1 FROM settings WHERE key=?').get(key);
if (!hasSetting('ui_mode')) setSetting('ui_mode', hasBusinessData() ? 'advanced' : 'simple');
if (!hasSetting('onboarded')) setSetting('onboarded', hasBusinessData() ? '1' : '0');

export function getSetting(key, def = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : def;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

export function round(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

export function now() {
  return db.prepare("SELECT datetime('now','localtime') AS t").get().t;
}
