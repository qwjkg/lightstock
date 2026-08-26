<template>
  <div>
    <div class="toolbar">
      <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" style="width:250px" />
      <el-button type="primary" @click="load">统计</el-button>
      <div style="flex:1"></div>
      <el-button @click="downloadFile('/export/profit', '毛利报表.xlsx')">导出 Excel</el-button>
    </div>
    <el-row :gutter="12" style="margin-bottom:12px">
      <el-col :span="6"><el-card shadow="never"><div class="kpi">销售额<b>{{ total.amount }}</b> 元</div></el-card></el-col>
      <el-col :span="6"><el-card shadow="never"><div class="kpi">销售成本<b>{{ total.cost }}</b> 元</div></el-card></el-col>
      <el-col :span="6"><el-card shadow="never"><div class="kpi">毛利<b style="color:#67c23a">{{ total.profit }}</b> 元</div></el-card></el-col>
      <el-col :span="6"><el-card shadow="never"><div class="kpi">毛利率<b>{{ total.rate }}</b> %</div></el-card></el-col>
    </el-row>
    <el-table :data="rows" border size="small" max-height="480">
      <el-table-column prop="name" label="商品" min-width="160" />
      <el-table-column prop="category" label="分类" width="110" />
      <el-table-column prop="qty_base" label="销量(基准)" width="110" />
      <el-table-column prop="amount" label="销售额" width="110" />
      <el-table-column prop="cost" label="成本" width="110" />
      <el-table-column prop="profit" label="毛利" width="110" />
    </el-table>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import api, { downloadFile } from '../api';

const rows = ref([]);
const total = ref({ amount: 0, cost: 0, profit: 0, rate: 0 });
const range = ref([]);
async function load() {
  const r = await api.get('/reports/profit', { params: { from: range.value?.[0] || '', to: range.value?.[1] || '' } });
  rows.value = r.rows; total.value = r.total;
}
onMounted(load);
</script>

<style scoped>.toolbar { display: flex; gap: 8px; margin-bottom: 12px; } .kpi { color: #606266; font-size: 13px; } .kpi b { display: block; font-size: 20px; margin-top: 4px; color: #303133; }</style>
