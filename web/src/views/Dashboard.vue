<template>
  <div>
    <el-row :gutter="12">
      <el-col :span="3" v-for="c in cards" :key="c.label">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-label">{{ c.label }}</div>
          <div class="stat-value">{{ c.value }}</div>
        </el-card>
      </el-col>
    </el-row>
    <el-row :gutter="12" style="margin-top:12px">
      <el-col :span="14">
        <el-card shadow="never" header="近 30 天进出货金额趋势">
          <div ref="trendRef" style="height:320px"></div>
        </el-card>
      </el-col>
      <el-col :span="10">
        <el-card shadow="never" header="库存金额 Top 10">
          <div ref="topRef" style="height:320px"></div>
        </el-card>
      </el-col>
    </el-row>
    <el-card shadow="never" style="margin-top:12px" header="最近出入库流水">
      <el-table :data="recent" size="small" max-height="360">
        <el-table-column prop="created_at" label="时间" width="160" />
        <el-table-column prop="product_name" label="商品" width="140" />
        <el-table-column prop="warehouse_name" label="仓库" width="110" />
        <el-table-column label="类型" width="100">
          <template #default="{ row }">{{ typeText(row.type) }}</template>
        </el-table-column>
        <el-table-column label="变动数量" width="100">
          <template #default="{ row }">
            <span :style="{ color: row.change_qty >= 0 ? '#67c23a' : '#f56c6c' }">{{ row.change_qty }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="amount" label="金额" width="100" />
        <el-table-column prop="ref_no" label="单号" width="160" />
        <el-table-column prop="remark" label="备注" show-overflow-tooltip />
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref, computed } from 'vue';
import * as echarts from 'echarts';
import api from '../api';

const data = ref({ stats: {}, trend: [], topStock: [], recent: [] });
const trendRef = ref(null);
const topRef = ref(null);
let trendChart = null, topChart = null;

const cards = computed(() => {
  const s = data.value.stats || {};
  return [
    { label: '商品数', value: s.productCount ?? '-' },
    { label: '仓库数', value: s.warehouseCount ?? '-' },
    { label: '库存总量(基准)', value: s.stockQty ?? '-' },
    { label: '库存总值(元)', value: money(s.stockValue) },
    { label: '今日进货(元)', value: money(s.todayPurchase) },
    { label: '今日出货(元)', value: money(s.todaySales) },
    { label: '低库存商品', value: s.lowStockCount ?? '-' }
  ];
});
const recent = computed(() => data.value.recent || []);
function money(v) { return (Number(v) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function typeText(t) {
  return { purchase_in: '采购入库', sale_out: '销售出库', adjustment: '库存调整', reversal: '作废冲销' }[t] || t;
}

async function load() {
  data.value = await api.get('/reports/dashboard');
  renderCharts();
}
function renderCharts() {
  const trend = data.value.trend || [];
  trendChart = trendChart || echarts.init(trendRef.value);
  trendChart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['进货', '出货'] },
    grid: { left: 50, right: 20, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: trend.map(d => d.order_date.slice(5)) },
    yAxis: { type: 'value' },
    series: [
      { name: '进货', type: 'line', smooth: true, data: trend.map(d => d.purchase), itemStyle: { color: '#409eff' } },
      { name: '出货', type: 'line', smooth: true, data: trend.map(d => d.sales), itemStyle: { color: '#67c23a' } }
    ]
  });
  topChart = topChart || echarts.init(topRef.value);
  const names = (data.value.topStock || []).map(x => x.name);
  topChart.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 10, right: 60, top: 10, bottom: 30, containLabel: true },
    xAxis: { type: 'value' },
    yAxis: { type: 'category', data: names.slice().reverse() },
    series: [{ type: 'bar', data: (data.value.topStock || []).map(x => x.value).reverse(), itemStyle: { color: '#f7ba2a' }, label: { show: true, position: 'right' } }]
  });
}
function onResize() { trendChart && trendChart.resize(); topChart && topChart.resize(); }

onMounted(() => { load(); window.addEventListener('resize', onResize); });
onUnmounted(() => { window.removeEventListener('resize', onResize); trendChart && trendChart.dispose(); topChart && topChart.dispose(); });
</script>

<style scoped>
.stat-card { text-align: center; margin-bottom: 8px; }
.stat-label { color: #909399; font-size: 13px; }
.stat-value { font-size: 20px; font-weight: 600; margin-top: 6px; }
</style>

