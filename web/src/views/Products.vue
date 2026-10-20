<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input v-model="query.keyword" placeholder="搜索名称/编号/条码/规格" clearable style="width:220px" @keyup.enter="load" @clear="load" />
      <el-select v-model="query.category" placeholder="全部分类" clearable style="width:140px" @change="load">
        <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
      </el-select>
      <el-button type="primary" @click="load">查询</el-button>
      <div style="flex:1"></div>
      <el-button @click="downloadTemplate">下载导入模板</el-button>
      <el-upload :show-file-list="false" accept=".xlsx,.xls" :before-upload="importFile">
        <el-button>Excel 导入</el-button>
      </el-upload>
      <el-button @click="exportData">导出 Excel</el-button>
      <el-button type="primary" @click="openDialog()">新增商品</el-button>
    </div>
    <el-table :data="rows" border size="small">
      <el-table-column prop="name" label="名称" min-width="130" fixed="left" />
      <el-table-column prop="category" label="分类" width="100" />
      <el-table-column prop="spec" label="规格" width="110" show-overflow-tooltip />
      <el-table-column prop="sku" label="编号" width="100" />
      <el-table-column prop="barcode" label="条码" width="120" />
      <el-table-column v-if="!isSimple" prop="unit_name" label="基准单位" width="90" />
      <el-table-column label="库存" width="110">
        <template #default="{ row }">
          <span :style="{ color: isLow(row) ? '#f56c6c' : 'inherit', fontWeight: isLow(row) ? 700 : 400 }">
            {{ row.stock_qty }} {{ row.unit_name }}{{ isLow(row) ? ' ⚠' : '' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column v-if="!isSimple" label="折算" width="120">
        <template #default="{ row }">{{ convertText(row) }}</template>
      </el-table-column>
      <el-table-column v-if="!isSimple" prop="weight_per_base_kg" label="重量kg/基准" width="110" />
      <el-table-column prop="purchase_price" label="默认进价" width="90" />
      <el-table-column prop="sale_price" label="默认售价" width="90" />
      <el-table-column v-if="!isSimple" label="平均成本" width="90">
        <template #default="{ row }">{{ (row.avg_cost || 0).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDialog(row)">编辑</el-button>
          <el-button link type="danger" @click="remove(row)">停用</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="form.id ? '编辑商品' : '新增商品'" width="640px">
      <el-form label-width="110px">
        <el-form-item label="名称" required><el-input v-model="form.name" /></el-form-item>
        <el-row :gutter="10">
          <el-col :span="12"><el-form-item label="分类"><el-input v-model="form.category" placeholder="如：饮品/食品" /></el-form-item></el-col>
          <template v-if="!isSimple || showMore">
            <el-col :span="12"><el-form-item label="规格"><el-input v-model="form.spec" placeholder="如：550ml" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="编号"><el-input v-model="form.sku" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="条码"><el-input v-model="form.barcode" /></el-form-item></el-col>
          </template>
          <template v-if="!isSimple">
            <el-col :span="12">
              <el-form-item label="基准单位" required>
                <el-select v-model="form.base_unit_id" placeholder="选择单位" style="width:100%">
                  <el-option v-for="u in countUnits" :key="u.id" :label="u.name" :value="u.id" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="12"><el-form-item label="重量kg/基准"><el-input-number v-model="form.weight_per_base_kg" :controls="false" style="width:100%" /></el-form-item></el-col>
          </template>
          <el-col :span="8"><el-form-item label="默认进价"><el-input-number v-model="form.purchase_price" :controls="false" style="width:100%" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="默认售价"><el-input-number v-model="form.sale_price" :controls="false" style="width:100%" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="低库存阈值"><el-input-number v-model="form.stock_low" :controls="false" style="width:100%" /></el-form-item></el-col>
        </el-row>
        <el-form-item v-if="isSimple && !showMore">
          <el-button link type="primary" @click="showMore = true">+ 更多字段（规格 / 编号 / 条码）</el-button>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" /></el-form-item>
        <template v-if="!isSimple">
          <el-divider content-position="left">自定义字段</el-divider>
          <CustomFields entity="product" :model="form.custom_data" />
        </template>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import * as XLSX from 'xlsx';
import api, { downloadFile } from '../api';
import CustomFields from '../components/CustomFields.vue';
import { isSimple } from '../mode';

const rows = ref([]);
const categories = ref([]);
const units = ref([]);
const showMore = ref(false);
const query = reactive({ keyword: '', category: '' });
const dialogVisible = ref(false);
const form = reactive({ id: null, name: '', sku: '', barcode: '', category: '', spec: '', base_unit_id: null, weight_per_base_kg: 0, purchase_price: 0, sale_price: 0, stock_low: 0, remark: '', custom_data: {} });

const countUnits = computed(() => units.value.filter(u => u.dimension === 'count' && u.active));
// 简易模式隐藏了「基准单位」下拉，统一落到默认的数量基准单位（即「件」）
const defaultUnitId = computed(() => units.value.find(u => u.dimension === 'count' && u.is_base)?.id ?? countUnits.value[0]?.id ?? null);

async function load() {
  const [p, c, u] = await Promise.all([
    api.get('/products', { params: query }),
    api.get('/products/categories'),
    api.get('/units')
  ]);
  rows.value = p; categories.value = c; units.value = u;
}
function openDialog(row) {
  showMore.value = false;
  Object.assign(form, row ? { ...row, custom_data: JSON.parse(row.custom_data || '{}') }
    : { id: null, name: '', sku: '', barcode: '', category: '', spec: '', base_unit_id: defaultUnitId.value, weight_per_base_kg: 0, purchase_price: 0, sale_price: 0, stock_low: 0, remark: '', custom_data: {} });
  dialogVisible.value = true;
}
async function save() {
  if (!form.name) return ElMessage.warning('请输入商品名称');
  // 简易模式没有基准单位下拉，用默认单位兜底，否则这条校验会让表单永远存不上
  if (isSimple.value && !form.base_unit_id) form.base_unit_id = defaultUnitId.value;
  if (!form.base_unit_id) return ElMessage.warning('请选择基准单位');
  if (form.id) await api.put('/products/' + form.id, form);
  else await api.post('/products', form);
  ElMessage.success('已保存'); dialogVisible.value = false; load();
}
async function remove(row) {
  await ElMessageBox.confirm(`确定停用商品「${row.name}」吗？`, '提示', { type: 'warning' });
  await api.delete('/products/' + row.id);
  ElMessage.success('已停用'); load();
}
function isLow(row) { return row.stock_low > 0 && row.stock_qty < row.stock_low; }
function convertText(row) {
  const parts = countUnits.value.filter(u => u.ratio > 1).map(u => {
    const v = row.stock_qty / u.ratio;
    return v >= 0.01 ? `${v.toFixed(2)}${u.name}` : null;
  }).filter(Boolean);
  return parts.slice(0, 2).join(' / ') || '—';
}
function exportData() { downloadFile('/export/products', '商品清单.xlsx'); }
function downloadTemplate() {
  const data = [{ '名称': '示例商品', '分类': '饮品', '规格': '550ml', '编号': 'SKU001', '条码': '', '基准单位': '件', '默认进价': 1, '默认售价': 1.5, '低库存阈值': 10, '每基准单位重量kg': 0.5, '备注': '' }];
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '商品');
  XLSX.writeFile(wb, '商品导入模板.xlsx');
}
async function importFile(file) {
  try {
    const wb = XLSX.read(await file.arrayBuffer());
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws);
    const rows2 = raw.map(r => ({
      name: r['名称'], category: r['分类'], spec: r['规格'], sku: r['编号'], barcode: r['条码'],
      base_unit: r['基准单位'], purchase_price: r['默认进价'], sale_price: r['默认售价'],
      stock_low: r['低库存阈值'], weight_per_base_kg: r['每基准单位重量kg'], remark: r['备注']
    })).filter(r => r.name);
    if (!rows2.length) { ElMessage.warning('没有识别到有效数据'); return false; }
    const res = await api.post('/import/products', { rows: rows2 });
    ElMessage.success(`导入完成：成功 ${res.ok} 条，跳过 ${res.skipped} 条`);
    load();
  } catch (e) { ElMessage.error('导入失败：' + (e.response?.data?.error || e.message)); }
  return false;
}
onMounted(load);
</script>

<style scoped>.toolbar { display: flex; gap: 8px; margin-bottom: 12px; }</style>
