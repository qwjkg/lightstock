<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input v-model="query.keyword" placeholder="搜索商品/备注/单号" clearable style="width:200px" @keyup.enter="load" @clear="load" />
      <el-select v-model="query.type" placeholder="全部类型" clearable style="width:130px" @change="load">
        <el-option label="采购入库" value="purchase_in" />
        <el-option label="销售出库" value="sale_out" />
        <el-option label="库存调整" value="adjustment" />
        <el-option label="作废冲销" value="reversal" />
      </el-select>
      <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" style="width:250px" @change="load" />
      <el-button type="primary" @click="load">查询</el-button>
      <div style="flex:1"></div>
      <el-button @click="downloadFile('/export/ledger', '库存流水.xlsx')">导出 Excel</el-button>
    </div>
    <el-table :data="rows" border size="small" max-height="640" v-loading="loading">
      <template #empty>
        <el-empty :image-size="80"
          :description="query.keyword || query.type || range?.length ? '没有匹配的流水' : '还没有进出记录'">
          <span class="empty-tip">{{ query.keyword || query.type || range?.length ? '换个筛选条件试试' : '进货、出货之后这里会留下记录' }}</span>
        </el-empty>
      </template>
      <el-table-column prop="created_at" label="时间" width="160" />
      <el-table-column prop="product_name" label="商品" min-width="120" />
      <el-table-column prop="warehouse_name" label="仓库" width="100" />
      <el-table-column label="类型" width="100">
        <template #default="{ row }">
          <el-tag :type="tagType(row.type)" size="small">{{ typeText(row.type) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="变动数量(基准)" width="130">
        <template #default="{ row }">
          <span :style="{ color: row.change_qty >= 0 ? '#67c23a' : '#f56c6c' }">{{ row.change_qty }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="unit_price" label="单价" width="90" />
      <el-table-column prop="amount" label="金额" width="100" />
      <el-table-column prop="balance" label="结存(基准)" width="100" />
      <el-table-column prop="ref_no" label="关联单号" width="150" />
      <el-table-column prop="remark" label="备注" min-width="150" show-overflow-tooltip />
    </el-table>
  </el-card>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import api, { downloadFile } from '../api';
import { showError } from '../ui';

const rows = ref([]);
const range = ref([]);
const loading = ref(false);
const query = reactive({ keyword: '', type: '' });
function typeText(t) { return { purchase_in: '采购入库', sale_out: '销售出库', adjustment: '库存调整', reversal: '作废冲销' }[t] || t; }
function tagType(t) { return { purchase_in: 'success', sale_out: 'danger', adjustment: 'warning', reversal: 'info' }[t] || 'info'; }
async function load() {
  loading.value = true;
  try {
    rows.value = await api.get('/ledger', { params: { ...query, from: range.value?.[0] || '', to: range.value?.[1] || '' } });
  } catch (e) {
    showError(e, '流水加载失败');
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>

<style scoped>.toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
.empty-tip { color: #909399; font-size: 13px; }</style>
