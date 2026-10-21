<template>
  <div class="m-shell">
    <header class="m-header">
      <span class="m-title">{{ businessName }}</span>
      <div class="m-actions">
        <button class="m-link m-ai-link" @click="openAi">✨ AI</button>
        <button class="m-link" @click="toDesktop">电脑版</button>
      </div>
    </header>

    <main class="m-main">
      <router-view :key="route.path" />
    </main>

    <nav class="m-tabs">
      <router-link v-for="t in tabs" :key="t.path" :to="t.path" class="m-tab"
                   :class="{ active: route.path.startsWith(t.path) }">
        <span class="m-tab-icon">{{ t.icon }}</span>
        <span class="m-tab-label">{{ t.label }}</span>
      </router-link>
    </nav>
  </div>
</template>

<script setup>
import { useRoute, useRouter } from 'vue-router';
import { businessName } from '../mode';
import { setLayoutPref } from '../device';
import { openAi } from '../ai/useAi';

const route = useRoute();
const router = useRouter();

const tabs = [
  { path: '/m/stock', label: '库存', icon: '📦' },
  { path: '/m/order', label: '开单', icon: '🧾' },
  { path: '/m/orders', label: '单据', icon: '📋' }
];

function toDesktop() {
  setLayoutPref('desktop');
  router.replace('/dashboard');
}
</script>

<style scoped>
.m-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #f5f7fa;
}
.m-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: #001529;
  color: #fff;
}
.m-title {
  font-size: 17px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m-link {
  flex: 0 0 auto;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, .35);
  color: #dbe2ea;
  border-radius: 14px;
  padding: 4px 12px;
  font-size: 12px;
}
.m-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.m-ai-link { border-color: rgba(230, 162, 60, .8); color: #ffd58a; }
.m-main {
  flex: 1 1 auto;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  /* 给底部页签留出空间，并避开手机底部安全区 */
  padding-bottom: calc(64px + env(safe-area-inset-bottom, 0px));
}
.m-tabs {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  background: #fff;
  border-top: 1px solid #e5e7eb;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  z-index: 100;
}
.m-tab {
  flex: 1;
  min-height: 56px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: #7b8794;
  text-decoration: none;
  font-size: 12px;
}
.m-tab.active { color: #0f5ac9; }
.m-tab-icon { font-size: 20px; line-height: 1; }
.m-tab-label { line-height: 1; }
</style>