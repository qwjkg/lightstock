# 轻进销存 LightStock

面向个体经商户的轻量进销存系统：多仓库、进货/出货、件/箱与重量换算、自定义字段、报表统计、Excel 导入导出、自动备份。

## 功能
- 基础资料：商品（规格/条码/分类/默认进售价）、供应商、客户、多仓库
- 计量单位：自定义单位与换算（1箱=24件）、每单位重量自动折算总重
- 业务单据：采购入库单、销售出库单（含数量/单价/金额/日期/备注）、冲销作废
- 库存：按仓库查询、低库存预警、库存调整（盘点）、全量流水
- 自定义字段：商品/单据可扩展文本、数字、日期、下拉字段
- 报表：进货/出货/毛利统计、仪表盘图表、Excel 导出
- 数据安全：SQLite 单文件、自动备份、Excel 批量导入

## 一键启动
1. 安装 [Node.js](https://nodejs.org/)（LTS 版本，安装时勾选 Add to PATH）
2. 双击 `start.bat`
3. 首次运行自动安装依赖并构建页面（需联网），随后浏览器打开 http://localhost:3000

关闭启动窗口即停止服务。数据保存在 `server/data/warehouse.db`，备份在 `server/data/backups/`。

## 目录结构
```
server/         后端（Express + SQLite + REST API）
web/            前端（Vue3 + Element Plus，构建产物由后端托管）
docs/           架构说明、API 清单、验收清单
start.bat       一键启动
```

## 扩展路线
Windows 桌面端（Tauri/Electron）与手机端（uni-app/H5）的扩展方案见 `docs/architecture.md`。
