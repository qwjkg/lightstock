import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getSetting, DB_PATH } from './db.js';
import { issueToken, hasToken } from './auth.js';
import basicRoutes from './routes/basic.js';
import orderRoutes from './routes/orders.js';
import stockRoutes from './routes/stock.js';
import reportRoutes from './routes/reports.js';
import systemRoutes, { createBackupFile } from './routes/system.js';
import demoRoutes from './routes/demo.js';
import aiRoutes from './routes/ai.js';
import { migrateCostV2 } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '20mb' }));

// 登录（设置了访问密码时使用）
app.post('/api/login', (req, res) => {
  const pw = getSetting('access_password', '');
  if (!pw) return res.json({ ok: true, token: null, password_required: false });
  if ((req.body && req.body.password) === pw) {
    return res.json({ ok: true, token: issueToken(), password_required: true });
  }
  res.status(401).json({ ok: false, error: '密码错误' });
});

// 访问密码校验
app.use('/api', (req, res, next) => {
  const pw = getSetting('access_password', '');
  if (!pw) return next();
  const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (hasToken(t)) return next();
  res.status(401).json({ ok: false, error: '请先登录' });
});

app.use('/api', basicRoutes);
app.use('/api', orderRoutes);
app.use('/api', stockRoutes);
app.use('/api', reportRoutes);
app.use('/api', systemRoutes);
app.use('/api', demoRoutes);
app.use('/api', aiRoutes);

// 托管前端构建产物
const dist = path.join(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist));
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
    res.sendFile(path.join(dist, 'index.html'));
  });
}

const PORT = Number(process.env.PORT || 3000);

// 成本算法一次性升级（幂等，跑过就跳过）。必须赶在 listen 之前同步完成：
// 否则先到的请求会读到「一半新成本、一半旧成本」的中间状态。
try {
  const migrated = await migrateCostV2();
  if (migrated) {
    console.log(`[迁移] 成本算法已升级为移动加权平均：${migrated.products} 个商品，回填 ${migrated.ledgerRows} 条流水、${migrated.itemRows} 条销售明细`);
    if (migrated.noCostSales) console.log(`[迁移] 注意：有 ${migrated.noCostSales} 笔出库当时无成本依据（该商品从未采购过），成本仍按 0 计`);
  }
} catch (err) {
  console.error('[迁移] 成本算法升级失败，已保留原数据:', err.message);
}

app.listen(PORT, () => {
  console.log('==========================================');
  console.log('  LightStock 已启动');
  console.log(`  本机访问: http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  局域网访问: http://${n.address}:${PORT}（手机/其他电脑）`);
    }
  }
  console.log(`  数据文件: ${DB_PATH}`);
  console.log('==========================================');
});

// 自动备份
const hours = Number(getSetting('auto_backup_hours', '6')) || 6;
setInterval(() => {
  createBackupFile().catch(err => console.error('自动备份失败:', err.message));
}, hours * 3600 * 1000);
setTimeout(() => {
  createBackupFile().then(() => console.log(`[备份] 启动时已自动备份到 server/data/backups/（每 ${hours} 小时一次）`)).catch(() => {});
}, 3000);
