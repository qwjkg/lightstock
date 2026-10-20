<template>
  <div class="m-page">
    <div class="m-toolbar">
      <span class="m-range">近 30 天的出货单</span>
      <button class="m-new" @click="router.push('/m/order')">+ 开新单</button>
    </div>

    <div v-if="loading" class="m-hint">加载中…</div>

    <div v-else-if="!rows.length" class="m-empty">
      <div class="m-empty-icon">📋</div>
      <p>最近 30 天还没有出货单</p>
      <p class="m-empty-sub">点右上角「开新单」开始</p>
    </div>

    <ul v-else class="m-list">
      <li v-for="o in rows" :key="o.id" class="m-order-card" :class="{ voided: o.status !== 'done' }">
        <div class="m-order-top">
          <span class="m-partner">{{ o.partner_name || '—' }}</span>
          <span class="m-amount">￥{{ o.total_amount }}</span>
        </div>
        <div class="m-order-meta">
          <span>{{ o.order_date }}</span>
          <span>{{ o.order_no }}</span>
          <span v-if="o.status !== 'done'" class="m-void">已作废</span>
        </div>
        <div v-if="o.status === 'done'" class="m-order-actions">
          <button @click="router.push('/m/order/' + o.id)">修改</button>
          <button class="danger" @click="voidOrder(o)">作废</button>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';
import { confirmAction, showError } from '../ui';

const router = useRouter();
const rows = ref([]);
const loading = ref(false);

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function load() {
  loading.value = true;
  try {
    rows.value = await api.get('/sales-orders', { params: { from: daysAgo(30), to: '' } });
  } catch (e) {
    showError(e, '单据加载失败');
  } finally {
    loading.value = false;
  }
}

async function voidOrder(o) {
  if (!(await confirmAction(`确定作废 ${o.order_no} 吗？库存会自动冲回。`, '作废确认'))) return;
  try {
    const r = await api.post(`/sales-orders/${o.id}/void`);
    if (r.negative && r.negative.length) {
      await ElMessageBox.alert(
        `作废后下列商品库存变为负数：${r.negative.map(n => `${n.name} ${n.quantity}`).join('、')}。请到「库存」页核对。`,
        '作废成功，但库存出现负数',
        { type: 'warning', confirmButtonText: '知道了' }
      );
    } else {
      ElMessage.success('已作废');
    }
    load();
  } catch (e) {
    showError(e, '作废失败');
  }
}

onMounted(load);
</script>

<style scoped>
.m-page { padding: 12px; }
.m-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.m-range { color: #909399; font-size: 13px; }
.m-new {
  height: 40px; padding: 0 16px; border: none; border-radius: 20px;
  background: #0f5ac9; color: #fff; font-size: 14px;
}
.m-hint { text-align: center; color: #909399; padding: 32px 0; }
.m-empty { text-align: center; color: #606266; padding: 48px 16px; }
.m-empty-icon { font-size: 40px; margin-bottom: 8px; }
.m-empty-sub { color: #909399; font-size: 13px; }
.m-list { list-style: none; margin: 0; padding: 0; }
.m-order-card { background: #fff; border-radius: 10px; padding: 14px; margin-bottom: 8px; }
.m-order-card.voided { opacity: .65; }
.m-order-top { display: flex; justify-content: space-between; align-items: baseline; }
.m-partner { font-size: 16px; font-weight: 600; color: #303133; }
.m-amount { font-size: 18px; font-weight: 700; color: #f56c6c; }
.m-order-meta { display: flex; gap: 10px; color: #909399; font-size: 12px; margin-top: 6px; flex-wrap: wrap; }
.m-void { color: #c0c4cc; }
.m-order-actions { display: flex; gap: 10px; margin-top: 12px; }
.m-order-actions button {
  flex: 1; min-height: 40px; border: 1px solid #dcdfe6; border-radius: 8px;
  background: #fff; color: #0f5ac9; font-size: 14px;
}
.m-order-actions button.danger { color: #f56c6c; border-color: #fbc4c4; }
</style>