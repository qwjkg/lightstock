<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-select v-model="query.warehouseId" placeholder="全部仓库" clearable style="width:150px" @change="load">
        <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
      </el-select>
      <el-input v-model="query.keyword" placeholder="搜索商品/编号/条码" clearable style="width:200px" @keyup.enter="load" @clear="load" />
      <el-checkbox v-model="query.lowOnly" label="仅看低库存" @change="load" />
      <el-button type="primary" @click="load">查询</el-button>
      <div style="flex:1"></div>
      <el-button @click="downloadFile('/export/stock', '库存清单.xlsx')">导出 Excel</el-button>
    </div>
    <el-table :data="rows" border size="small" max-height="640" v-loading="loading">
      <template #empty>
        <el-empty :image-size="80"
          :description="query.keyword || query.lowOnly ? '没有匹配的库存记录' : '还没有库存'">
          <span v-if="!query.keyword && !query.lowOnly" class="empty-tip">进货之后这里会显示库存</span>
          <span v-else class="empty-tip">换个筛选条件试试</span>
        </el-empty>
      </template>
      <el-table-column prop="name" label="商品" min-width="140" fixed="left" />
      <el-table-column prop="category" label="分类" width="100" />
      <el-table-column prop="spec" label="规格" width="100" show-overflow-tooltip />
      <el-table-column prop="warehouse_name" label="仓库" width="110" />
      <el-table-column :label="isSimple ? '库存' : '库存(基准)'" width="120">
        <template #default="{ row }">
          <span :style="{ color: isBad(row) ? '#f56c6c' : 'inherit', fontWeight: isBad(row) ? 700 : 400 }">
            {{ row.quantity }} {{ row.unit_name }}{{ row.quantity < 0 ? ' ⚠负数' : (isLow(row) ? ' ⚠' : '') }}
          </span>
        </template>
      </el-table-column>
      <el-table-column v-if="!isSimple" label="折算" width="120">
        <template #default="{ row }">{{ convertText(row) }}</template>
      </el-table-column>
      <el-table-column v-if="!isSimple" prop="weight_kg" label="重量(kg)" width="100" />
      <el-table-column v-if="!isSimple" prop="avg_cost" label="平均成本" width="90" />
      <el-table-column prop="stock_value" label="库存金额" width="100" />
      <el-table-column prop="stock_low" label="预警阈值" width="90" />
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openAdjust(row)">调整</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="adjustVisible" title="库存调整（盘点/修正）" width="460px">
      <el-form label-width="90px">
        <el-form-item label="商品"><b>{{ adjustRow.name }}</b>（{{ adjustRow.warehouse_name }}）</el-form-item>
        <el-form-item v-if="!isSimple" label="调整单位">
          <el-select v-model="adjustForm.unit_id" style="width:100%">
            <el-option v-for="u in countUnits" :key="u.id" :label="u.name" :value="u.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="调整数量" required>
          <el-input-number v-model="adjustForm.delta_qty" :controls="false" style="width:100%" placeholder="正数为增加，负数为减少" />
        </el-form-item>
        <el-form-item label="原因"><el-input v-model="adjustForm.remark" placeholder="如：盘点差异" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adjustVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAdjust">确认调整</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import api, { downloadFile } from '../api';
import { showError } from '../ui';
import { isSimple } from '../mode';

const rows = ref([]);
const warehouses = ref([]);
const units = ref([]);
const loading = ref(false);
const query = reactive({ warehouseId: '', keyword: '', lowOnly: false });
const adjustVisible = ref(false);
const adjustRow = ref({});
const adjustForm = reactive({ unit_id: null, delta_qty: 0, remark: '' });

const countUnits = computed(() => units.value.filter(u => u.dimension === 'count' && u.active));
const defaultUnitId = computed(() => units.value.find(u => u.dimension === 'count' && u.is_base)?.id ?? countUnits.value[0]?.id ?? null);

async function load() {
  loading.value = true;
  try {
    const [s, w, u] = await Promise.all([
      // lowOnly 后端只认 '1'；之前传的是布尔值，这个筛选其实一直没生效
      api.get('/stock', { params: { ...query, lowOnly: query.lowOnly ? '1' : '' } }),
      api.get('/warehouses'),
      api.get('/units')
    ]);
    rows.value = s; warehouses.value = w; units.value = u;
  } catch (e) {
    showError(e, '库存加载失败');
  } finally {
    loading.value = false;
  }
}
function isLow(row) { return row.stock_low > 0 && Number(row.quantity) < row.stock_low; }
// 负数库存是账实不符的信号，和低库存一样必须显眼
function isBad(row) { return Number(row.quantity) < 0 || isLow(row); }
function convertText(row) {
  const parts = countUnits.value.filter(u => u.ratio > 1).map(u => {
    const v = row.quantity / u.ratio;
    return v >= 0.01 ? `${v.toFixed(2)}${u.name}` : null;
  }).filter(Boolean);
  return parts.slice(0, 2).join(' / ') || '—';
}
function openAdjust(row) {
  adjustRow.value = row;
  Object.assign(adjustForm, { unit_id: row.base_unit_id ?? defaultUnitId.value, delta_qty: 0, remark: '' });
  adjustVisible.value = true;
}
async function submitAdjust() {
  if (!adjustForm.delta_qty) return ElMessage.warning('调整数量不能为 0');
  try {
    await api.post('/stock/adjust', { product_id: adjustRow.value.product_id, warehouse_id: adjustRow.value.warehouse_id, unit_id: adjustForm.unit_id, delta_qty: adjustForm.delta_qty, remark: adjustForm.remark });
    ElMessage.success('已调整'); adjustVisible.value = false; load();
  } catch (e) {
    showError(e, '调整失败');
  }
}
onMounted(load);
</script>

<style scoped>.toolbar { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
.empty-tip { color: #909399; font-size: 13px; }</style>
