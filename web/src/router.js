import { createRouter, createWebHashHistory } from 'vue-router';
import { prefersMobile, homeForDevice } from './device';

// meta.simple: false 表示「简易模式」下不出现在左侧菜单（路由本身仍可访问，
// 例如仓库改由 设置→仓库 进入、库存流水并入 库存 页的页签）。
// meta.layout: 'mobile' 表示渲染移动端外壳（App.vue 据此切换布局）。
const routes = [
  { path: '/login', component: () => import('./views/Login.vue') },
  { path: '/', redirect: () => homeForDevice() },
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
  { path: '/settings', component: () => import('./views/Settings.vue'), meta: { title: '系统设置', icon: 'Setting' } },

  // 手机端自成一套页面：不和桌面页一一对应，切换时各自回首页。
  // 父路由不要加 meta.title，否则会出现在桌面侧栏。
  {
    path: '/m',
    component: () => import('./mobile/MobileShell.vue'),
    meta: { layout: 'mobile' },
    children: [
      { path: '', redirect: '/m/stock' },
      { path: 'stock', component: () => import('./mobile/MobileStock.vue'), meta: { title: '库存' } },
      { path: 'order/:id?', component: () => import('./mobile/MobileOrder.vue'), meta: { title: '开单' } },
      { path: 'orders', component: () => import('./mobile/MobileOrders.vue'), meta: { title: '单据' } }
    ]
  }
];

const router = createRouter({ history: createWebHashHistory(), routes });

// 布局只在「第一次进入」判断一次：电脑用户把窗口拖窄，不应该被弹到手机版。
// /login 不消耗这次机会——登录后还得回到正确的首页。
let bootstrapped = false;
router.beforeEach(to => {
  if (bootstrapped) return true;
  if (to.path === '/login') return true;
  bootstrapped = true;
  if (!to.path.startsWith('/m') && prefersMobile()) return { path: '/m/stock', replace: true };
  return true;
});

export default router;