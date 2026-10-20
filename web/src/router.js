import { createRouter, createWebHashHistory } from 'vue-router';

// meta.simple: false 表示「简易模式」下不出现在左侧菜单（路由本身仍可访问，
// 例如仓库改由 设置→仓库 进入、库存流水并入 库存 页的页签）。
const routes = [
  { path: '/login', component: () => import('./views/Login.vue') },
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', component: () => import('./views/Dashboard.vue'), meta: { title: '仪表盘', icon: 'Odometer' } },
  { path: '/products', component: () => import('./views/Products.vue'), meta: { title: '商品管理', icon: 'Goods' } },
  { path: '/suppliers', component: () => import('./views/Partners.vue'), props: { kind: 'suppliers' }, meta: { title: '供应商', icon: 'Van' } },
  { path: '/customers', component: () => import('./views/Partners.vue'), props: { kind: 'customers' }, meta: { title: '客户', icon: 'User' } },
  { path: '/warehouses', component: () => import('./views/Warehouses.vue'), meta: { title: '仓库', icon: 'OfficeBuilding', simple: false } },
  { path: '/units', component: () => import('./views/Units.vue'), meta: { title: '计量单位', icon: 'ScaleToOriginal', simple: false } },
  { path: '/purchase', component: () => import('./views/Orders.vue'), props: { kind: 'purchase' }, meta: { title: '进货管理', icon: 'Download' } },
  { path: '/sales', component: () => import('./views/Orders.vue'), props: { kind: 'sales' }, meta: { title: '出货管理', icon: 'Upload' } },
  { path: '/stock', component: () => import('./views/StockHub.vue'), meta: { title: '库存查询', icon: 'Box' } },
  { path: '/ledger', component: () => import('./views/Ledger.vue'), meta: { title: '库存流水', icon: 'List', simple: false } },
  { path: '/reports', component: () => import('./views/Reports.vue'), meta: { title: '报表统计', icon: 'TrendCharts' } },
  { path: '/settings', component: () => import('./views/Settings.vue'), meta: { title: '系统设置', icon: 'Setting' } }
];

export default createRouter({ history: createWebHashHistory(), routes });
