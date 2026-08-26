<template>
  <div>
    <div class="toolbar">
      <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" style="width:250px" />
      <el-select v-model="params.partnerId" :placeholder="'全部' + partnerLabel" clearable style="width:150px">
        <el-option v-for="p in partners" :key="p.id" :label="p.name" :value="p.id" />
      </el-select>
      <el-select v-model="params.groupBy" style="width:130px">
        <el-option label="按商品汇总" value="product" />
        <el-option :label="'按' + partnerLabel + '汇总'" value="partner" />
        <el-option label="按日期汇总" value="day" />
      </el-select>
      <el-button type="primary" @click="load">统计</el-button>
      <div style="flex:1"></div>
      <el-button @click="exportExcel">导出 Excel</el-button>
    </div>
    <el-table :data="rows" border size="small" max-height="520">
      <el-table-column prop="name" :label="groupLabel" min-width="160" />
      <el-table-column prop="order_count" label="单数" width="80" />
      <el-table-column prop="qty_base" label="数量(基准)" width="110" />
      <el-table-column prop="weight_kg" label="重量(kg)" width="100" />
      <el-table-column prop="amount" label="金额(元)" width="120" />
    </el-table>
    <div class="total-bar">
      合计：{{ total.qty }} 基准数量　|　{{ total.weight }} kg　|　<b>{{ total.amount }} 元</b>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import api, { downloadFile } from '../api';

const props = defineProps({ kind: { type: String, required: true } });
const partnerLabel = computed(() => props.kind === 'purchase' ? '供应商' : '客户');
const url = computed(() => '/reports/' + props.kind);
const exportUrl = computed(() => props.kind === 'purchase' ? '/export/purchase' : '/export/sales');
const rows = ref([]);
const total = ref({ qty: 0, weight: 0, amount: 0 });
const groupLabel = ref('商品');
const range = ref([]);
const partners = ref([]);
const params = ref({ partnerId: '', groupBy: 'product' });

async function load() {
  const r = await api.get(url.value, { params: { ...params.value, from: range.value?.[0] || '', to: range.value?.[1] || '' } });
  rows.value = r.rows; total.value = r.total; groupLabel.value = r.groupLabel;
}
function exportExcel() { downloadFile(exportUrl.value, (props.kind === 'purchase' ? '进货明细' : '出货明细') + '.xlsx'); }
onMounted(async () => {
  partners.value = await api.get(props.kind === 'purchase' ? '/suppliers' : '/customers');
  load();
});
</script>

<style scoped>.toolbar { display: flex; gap: 8px; margin-bottom: 12px; } .total-bar { margin-top: 10px; background: #f5f7fa; padding: 8px 12px; border-radius: 4px; }</style>
