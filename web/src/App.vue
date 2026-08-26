<template>
  <router-view v-if="route.path === '/login'" />
  <el-container v-else class="app-shell">
    <el-aside width="200px" class="aside">
      <div class="logo">📦 轻进销存</div>
      <el-menu :default-active="route.path" router class="menu">
        <el-menu-item v-for="r in menus" :key="r.path" :index="r.path">
          <el-icon><component :is="r.meta.icon" /></el-icon>
          <span>{{ r.meta.title }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <span class="page-title">{{ route.meta.title || '' }}</span>
        <span class="business">{{ businessName }}</span>
        <el-button link type="primary" @click="$router.push('/settings')">设置</el-button>
      </el-header>
      <el-main class="main"><router-view :key="route.path" /></el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import api from './api';
import router from './router';

const route = useRoute();
const businessName = ref('我的店铺');
const menus = router.options.routes.filter(r => r.meta && r.meta.title);

onMounted(async () => {
  try {
    const s = await api.get('/settings');
    businessName.value = s.business_name;
    document.title = `${s.business_name} - 轻进销存`;
  } catch { /* 未设置密码时可能失败，忽略 */ }
});
</script>

<style scoped>
.app-shell { height: 100%; }
.aside { background: #001529; }
.logo { color: #fff; font-size: 17px; font-weight: 600; text-align: center; padding: 18px 0; letter-spacing: 1px; }
.menu { border-right: none; background: #001529; }
.menu :deep(.el-menu-item) { color: #b7c3d3; }
.menu :deep(.el-menu-item.is-active) { color: #fff; background: #0f5ac9; }
.header { display: flex; align-items: center; gap: 12px; background: #fff; border-bottom: 1px solid #e5e7eb; }
.page-title { font-size: 16px; font-weight: 600; }
.business { flex: 1; color: #909399; font-size: 13px; text-align: right; margin-right: 8px; }
.main { background: #f5f7fa; padding: 16px; }
</style>


