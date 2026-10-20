<template>
  <div class="m-page">
    <div class="m-toolbar">
      <input
        v-model="keyword"
        class="m-input"
        type="search"
        inputmode="search"
        placeholder="搜索商品名称 / 编号"
        @input="onInput"
        @keyup.enter="load"
      />
      <button class="m-chip" :class="{ on: lowOnly }" @click="toggleLow">
        只看低库存
      </button>
    </div>

    <div v-if="loading" class="m-hint">加载中…</div>

    <div v-else-if="!rows.length" class="m-empty">
      <div class="m-empty-icon">📦</div>
      <p>{{ keyword ? `没有匹配「${keyword}」的商品` : '还没有库存记录' }}</p>
      <p class="m-empty-sub">
        {{ keyword ? '换个关键词试试' : '到电脑上进货或添加商品后，这里会显示库存' }}
      </p>
    </div>

    <template v-else>
      <div class="m-count">{{ rows.length }} 种商品</div>
      <ul class="m-list">
        <li v-for="r in rows" :key="r.product_id + '-' + r.warehouse_id" class="m-card">
          <div class="m-card-body">
            <div class="m-card-title">
              {{ r.name }}
              <span v-if="r.spec" class="m-spec">{{ r.spec }}</span>
            </div>
            <div class="m-card-sub">
              {{ r.category || '未分类' }}
              <template v-if="multiWarehouse"> · {{ r.warehouse_name }}</template>
            </div>
          </div>
          <div class="m-stock" :class="{ low: isLow(r), neg: r.quantity < 0 }">
            <b>{{ fmt(r.quantity) }}</b>
            <span class="m-unit">{{ r.unit_name || '' }}</span>
            <span v-if="isLow(r)" class="m-warn">低库存</span>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import api from '../api';
import { showError } from '../ui';

const rows = ref([]);
const warehouses = ref([]);
const keyword = ref('');
const lowOnly = ref(false);
const loading = ref(false);
let timer = null;

const multiWarehouse = () => warehouses.value.length > 1;

function fmt(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}
function isLow(r) {
  return r.stock_low > 0 && Number(r.quantity) < r.stock_low;
}

function onInput() {
  clearTimeout(timer);
  timer = setTimeout(load, 300);
}
function toggleLow() {
  lowOnly.value = !lowOnly.value;
  load();
}

async function load() {
  loading.value = true;
  try {
    const [s, w] = await Promise.all([
      api.get('/stock', { params: { keyword: keyword.value, lowOnly: lowOnly.value ? '1' : '' } }),
      warehouses.value.length ? Promise.resolve(warehouses.value) : api.get('/warehouses')
    ]);
    rows.value = s;
    warehouses.value = w;
  } catch (e) {
    showError(e, '库存加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.m-page { padding: 12px; }
.m-toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
.m-input {
  flex: 1;
  min-width: 0;
  height: 44px;
  padding: 0 14px;
  font-size: 16px;           /* 16px 以上 iOS 不会自动放大 */
  border: 1px solid #dcdfe6;
  border-radius: 8px;
  background: #fff;
  outline: none;
}
.m-input:focus { border-color: #0f5ac9; }
.m-chip {
  flex: 0 0 auto;
  height: 44px;
  padding: 0 14px;
  border: 1px solid #dcdfe6;
  border-radius: 8px;
  background: #fff;
  color: #606266;
  font-size: 14px;
}
.m-chip.on { background: #ecf5ff; border-color: #0f5ac9; color: #0f5ac9; }
.m-count { color: #909399; font-size: 12px; margin: 0 4px 8px; }
.m-list { list-style: none; margin: 0; padding: 0; }
.m-card {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #fff;
  border-radius: 10px;
  padding: 14px;
  margin-bottom: 8px;
}
.m-card-body { flex: 1; min-width: 0; }
.m-card-title { font-size: 16px; font-weight: 600; color: #303133; word-break: break-all; }
.m-spec { font-weight: 400; color: #909399; font-size: 13px; margin-left: 4px; }
.m-card-sub { color: #909399; font-size: 12px; margin-top: 4px; }
.m-stock { flex: 0 0 auto; text-align: right; color: #303133; font-size: 22px; font-weight: 700; }
.m-stock .m-unit { font-size: 12px; font-weight: 400; color: #909399; margin-left: 2px; }
.m-stock.low { color: #e6a23c; }
.m-stock.neg { color: #f56c6c; }
.m-warn { display: block; font-size: 11px; font-weight: 400; color: #e6a23c; }
.m-hint { text-align: center; color: #909399; padding: 32px 0; }
.m-empty { text-align: center; color: #606266; padding: 48px 16px; }
.m-empty-icon { font-size: 40px; margin-bottom: 8px; }
.m-empty-sub { color: #909399; font-size: 13px; }
</style>