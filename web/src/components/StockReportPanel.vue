<template>
  <div>
    <div class="toolbar">
      <el-select v-model="warehouseId" placeholder="全部仓库" clearable style="width:150px">
        <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
      </el-select>
      <el-button type="primary" @click="load">统计</el-button>
      <div style="flex:1"></div>
      <el-button @click="downloadFile('/export/stock', '库存报表.xlsx')">导出 Excel</el-button>
    </div>
    <div class="total-bar">商品数：{{ rows.length }}　|　库存总量：{{ sum('quantity') }} 基准单位　|　库存总值：<b>{{ sum('stock_value') }} 元</b></div>
    <el-table :data="rows" border size="small" max-height="520" style="margin-top:10px">
      <el-table-column prop="name" label="商品" min-width="140" />
      <el-table-column prop="category" label="分类" width="100" />
      <el-table-column prop="warehouse_name" label="仓库" width="110" />
      <el-table-column prop="quantity" label="库存(基准)" width="100" />
      <el-table-column prop="weight_kg" label="重量(kg)" width="100" />
      <el-table-column prop="avg_cost" label="平均成本" width="90" />
      <el-table-column prop="stock_value" label="库存金额" width="110" />
    </el-table>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import api, { downloadFile } from '../api';

const rows = ref([]);
const warehouses = ref([]);
const warehouseId = ref('');
function sum(key) { return rows.value.reduce((s, r) => s + (Number(r[key]) || 0), 0).toFixed(2); }
async function load() {
  rows.value = await api.get('/stock', { params: { warehouseId: warehouseId.value } });
}
onMounted(async () => { warehouses.value = await api.get('/warehouses'); load(); });
</script>

<style scoped>.toolbar { display: flex; gap: 8px; } .total-bar { background: #f5f7fa; padding: 8px 12px; border-radius: 4px; }</style>
