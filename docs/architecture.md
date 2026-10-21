# 架构说明与三端扩展路线

## 当前架构（Web 端）
```
浏览器 ──HTTP──▶ Express 静态托管（web/dist）＋ REST API
                     │
                     └── better-sqlite3（server/data/warehouse.db 单文件）
```
- 后端：`server/`（Node.js + Express + better-sqlite3），全部业务逻辑走 REST API，事务保证库存账目一致
- 前端：`web/`（Vue3 + Element Plus + ECharts），构建后由后端直接托管，一键 `start.bat` 启动
- 数据：单文件 SQLite + WAL；启动时与定时自动备份到 `server/data/backups/`

## 为什么这样分层（为三端扩展预留）
- 后端是**纯 API + 静态文件**，不绑定浏览器专有特性 → Windows 桌面端、手机端可共用同一套接口
- 前端**组件化、按模块拆分**，桌面/手机后续各写各的壳，复用 API 与设计
- 数据模型借鉴 InvenTree（商品/仓库/库存/流水台账）与 jshERP（中文进销存单据流），标准化后未来迁移无忧

## Windows 桌面端（二期）
| 方案 | 安装包 | 内存占用 | 构建工具链 | 结论 |
|---|---|---|---|---|
| Tauri 2 | 5~10MB | 低（系统 WebView） | 需装一次 Rust | 推荐：最轻 |
| Electron | 100~200MB | 高 | 纯 Node（现成） | 备选：省事 |
做法：将 `web/dist` 作为壳的静态资源，打包 NSIS 安装包；API 地址指向本机 `localhost:3000` 或由壳内置启动后端进程。

## 手机端（三期）
1. **H5/PWA（零成本，已可用）**：同一局域网内手机浏览器访问电脑 IP（服务启动时控制台会打印），可"添加到主屏幕"
2. **uni-app 真 App（推荐）**：Vue 语法与现有技术栈一致，一套代码编译 Android APK / iOS / 微信小程序，对接同一 REST API
3. iOS 上架需 Apple 开发者账号，个体户实际建议 Android APK + iPhone 走 H5

## 目录结构
```
server/src/db.js          数据库连接、迁移、默认数据
server/src/services/stock.js  进销存核心账本逻辑（事务）
server/src/routes/         REST API 路由
web/src/views/             页面（仪表盘/商品/单据/库存/报表/设置）
docs/                      架构说明、API 清单、验收清单
```

## AI 助手层（P0 只读 + P1 受控写入）

```
浏览器 AI 抽屉 ──/api/ai/*──▶ routes/ai.js
                                ├─ ai/agent.js       按权限过滤工具 + 工具循环（最多 6 轮）
                                ├─ ai/tools.js       17 个只读工具 + 5 个写提案工具（3 普通 + 2 高风险；参数化 + LIMIT + 校验）
                                ├─ ai/permissions.js 会话 / 授权（可记账/高风险） / 待确认操作（内存，5 分钟过期）
                                ├─ ai/actions.js     用户确认后复用 services/stock.js 执行
                                ├─ ai/provider.js    OpenAI 兼容客户端（DeepSeek 预设）
                                ├─ ai/prompt.js      业务知识卡 / 系统提示词
                                └─ ai/audit.js       ai_audit_log 审计
```

- 模型不直接连库、不直接写库；所有数字由工具查询，前端同时渲染服务端生成的数据卡片。
- 写操作走「AI 提议 → 用户确认 → 重新校验 → services/stock.js 执行」；确认令牌不进入模型上下文。
- 默认只读；「可记账」权限 15 分钟，高风险（作废/改单）5 分钟，写前自动备份，每次写入仍需二次确认。
- 手机端由 `MobileShell` 顶部「✨ AI」打开同一抽屉的全屏模式；局域网使用需先设置访问密码。
- AI 会话、权限、待确认操作在内存中，服务重启即失效；审计落 `ai_audit_log`。
- API Key 只存服务端（环境变量或 `server/data/ai.key`），不写入数据库备份。

## 关键技术决策
- **库存一致性**：所有出入库写 `stock_ledger` 流水 + `stock` 结存，同一事务内完成，异常自动回滚
- **成本核算**：移动加权平均（采购总金额/采购总数量），作废采购单反向冲销后自动重算
- **单位换算**：单位表 ratio（1箱=24件），单据按所选单位录入，系统折算基准单位入账；重量=数量×换算倍数×每基准单位重量
- **自定义字段**：定义表 + 业务表 custom_data JSON 列，新增字段无需改表
- **备份**：SQLite 官方 backup API，不中断服务
