import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
export const DB_PATH = path.join(dataDir, 'warehouse.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// 首次初始化：默认单位、默认仓库、默认设置
const unitCount = db.prepare('SELECT COUNT(*) AS c FROM units').get().c;
if (unitCount === 0) {
  const ins = db.prepare('INSERT INTO units (name, dimension, ratio, is_base, sort_order) VALUES (?,?,?,?,?)');
  ins.run('件', 'count', 1, 1, 1);
  ins.run('箱', 'count', 24, 0, 2);
  ins.run('打', 'count', 12, 0, 3);
  ins.run('公斤', 'weight', 1, 1, 4);
  ins.run('克', 'weight', 0.001, 0, 5);
  ins.run('吨', 'weight', 1000, 0, 6);
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
