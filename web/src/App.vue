<template>
  <router-view v-if="route.path === '/login'" />
  <!-- 移动端路由自带外壳（底部页签），不再套桌面侧栏 -->
  <router-view v-else-if="isMobileLayout" />
  <el-container v-else class="app-shell">
    <el-aside width="200px" class="aside">
      <div class="logo" :title="businessName">📦 {{ businessName }}</div>
      <el-menu :default-active="route.path" router class="menu">
        <el-menu-item v-for="r in menus" :key="r.path" :index="r.path">
          <el-icon><component :is="r.meta.icon" /></el-icon>
          <span>{{ r.meta.title }}</span>
        </el-menu-item>
      </el-menu>
      <div class="mode-badge" v-if="isSimple">简易模式 · 可在设置中切换</div>
    </el-aside>
    <el-container>
      <el-header class="header">
        <span class="page-title">{{ route.meta.title || '' }}</span>
        <div style="flex:1"></div>
        <el-button link type="primary" @click="$router.push('/settings')">设置</el-button>
      </el-header>
      <el-main class="main"><router-view :key="route.path" /></el-main>
    </el-container>
  </el-container>
  <!-- 引导在两个布局下都要能出现，所以放在外壳之外 -->
  <OnboardingWizard v-if="settingsLoaded && !onboarded && route.path !== '/login'" />
</template>

<script setup>
import { computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import router from './router';
import { isSimple, businessName, onboarded, settingsLoaded, loadSettings } from './mode';
import OnboardingWizard from './components/OnboardingWizard.vue';

const route = useRoute();

// 简易模式过滤掉 meta.simple === false 的菜单项（计量单位 / 仓库 / 库存流水）
const menus = computed(() => router.options.routes.filter(
  r => r.meta && r.meta.title && (!isSimple.value || r.meta.simple !== false)
));

const isMobileLayout = computed(() => route.matched.some(r => r.meta && r.meta.layout === 'mobile'));

onMounted(async () => {
  try {
    await loadSettings();
  } catch { /* 未登录时接口 401，已在拦截器里跳转登录页 */ }
});

// 浏览器标签直接用店铺名，不再挂产品名
watch(businessName, v => { document.title = v; }, { immediate: true });
</script>

<style scoped>
.app-shell { height: 100%; }
.aside { background: #001529; }
.logo { color: #fff; font-size: 17px; font-weight: 600; text-align: center; padding: 18px 12px; letter-spacing: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu { border-right: none; background: #001529; }
.menu :deep(.el-menu-item) { color: #b7c3d3; }
.menu :deep(.el-menu-item.is-active) { color: #fff; background: #0f5ac9; }
.mode-badge { color: #6b7a8d; font-size: 12px; text-align: center; padding: 12px 8px; }
.header { display: flex; align-items: center; gap: 12px; background: #fff; border-bottom: 1px solid #e5e7eb; }
.page-title { font-size: 16px; font-weight: 600; }
.main { background: #f5f7fa; padding: 16px; }
</style>


