<template>
  <div>
    <el-card shadow="never">
      <div class="toolbar">
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" style="width:250px" @change="load" />
        <el-select v-model="query.partnerId" :placeholder="'全部' + partnerLabel" clearable style="width:160px" @change="load">
          <el-option v-for="p in partners" :key="p.id" :label="p.name" :value="p.id" />
        </el-select>
        <el-input v-model="query.keyword" placeholder="搜索单号/备注" clearable style="width:170px" @keyup.enter="load" @clear="load" />
        <el-button type="primary" @click="load">查询</el-button>
        <div style="flex:1"></div>
        <el-button type="primary" @click="openCreate">新增{{ kindText }}单</el-button>
      </div>
      <el-table :data="rows" border size="small">
        <el-table-column prop="order_no" label="单号" width="160" fixed="left" />
        <el-table-column prop="order_date" label="日期" width="110" />
        <el-table-column :prop="partnerField" label="往来单位" min-width="130">
          <template #default="{ row }">{{ row.partner_name }}</template>
        </el-table-column>
        <el-table-column prop="warehouse_name" label="仓库" width="100" />
        <el-table-column prop="item_count" label="明细数" width="80" />
        <el-table-column prop="total_amount" label="金额(元)" width="110" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'done' ? 'success' : 'info'" size="small">{{ row.status === 'done' ? '正常' : '已作废' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="120" show-overflow-tooltip />
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">查看</el-button>
            <el-button v-if="row.status === 'done'" link type="danger" @click="voidOrder(row)">作废</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新建单据 -->
    <el-dialog v-model="createVisible" :title="'新增' + kindText + '单'" width="860px" top="4vh">
      <el-form label-width="80px">
        <el-row :gutter="10">
          <el-col :span="8">
            <el-form-item :label="partnerLabel" required>
              <div style="display:flex; gap:4px; width:100%">
                <el-select v-model="draft.partner_id" filterable placeholder="选择" style="flex:1">
                  <el-option v-for="p in partners" :key="p.id" :label="p.name" :value="p.id" />
                </el-select>
                <el-button @click="openQuickPartner" title="快速新增" style="flex-shrink:0"><el-icon><Plus /></el-icon></el-button>
              </div>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="仓库" required>
              <el-select v-model="draft.warehouse_id" placeholder="选择" style="width:100%">
                <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="日期" required>
              <el-date-picker v-model="draft.order_date" type="date" value-format="YYYY-MM-DD" style="width:100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="备注"><el-input v-model="draft.remark" /></el-form-item>
        <el-divider content-position="left">商品明细（数量按所选单位录入，系统自动折算基准单位）</el-divider>
        <el-table :data="draft.items" border size="small">
          <el-table-column label="商品" min-width="200">
            <template #default="{ row }">
              <el-select v-model="row.product_id" filterable placeholder="选择商品" style="width:100%" @change="onProductChange(row)">
                <el-option v-for="p in products" :key="p.id" :label="p.name + (p.spec ? '（' + p.spec + '）' : '')" :value="p.id" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="单位" width="100">
            <template #default="{ row }">
              <el-select v-model="row.unit_id" style="width:100%">
                <el-option v-for="u in countUnits" :key="u.id" :label="u.name" :value="u.id" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="数量" width="110">
            <template #default="{ row }"><el-input-number v-model="row.quantity" :min="0" :controls="false" style="width:100%" /></template>
          </el-table-column>
          <el-table-column label="单价" width="110">
            <template #default="{ row }"><el-input-number v-model="row.unit_price" :min="0" :precision="2" :controls="false" style="width:100%" /></template>
          </el-table-column>
          <el-table-column label="金额" width="110">
            <template #default="{ row }">{{ lineAmount(row) }}</template>
          </el-table-column>
          <el-table-column label="重量kg" width="90">
            <template #default="{ row }">{{ lineWeight(row) }}</template>
          </el-table-column>
          <el-table-column width="60">
            <template #default="{ $index }"><el-button link type="danger" @click="draft.items.splice($index, 1)">删除</el-button></template>
          </el-table-column>
        </el-table>
        <el-button style="margin-top:10px" @click="addLine">+ 添加明细</el-button>
        <div class="total-bar">
          <span>合计：<b>{{ totalAmount }}</b> 元　|　总重：<b>{{ totalWeight }}</b> kg</span>
        </div>
        <CustomFields :entity="kind === 'purchase' ? 'purchase_order' : 'sales_order'" :model="draft.custom_data" />
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">保存单据</el-button>
      </template>
    </el-dialog>

    <!-- 快速新增往来单位 -->
    <el-dialog v-model="quickVisible" :title="'快速新增' + partnerLabel" width="460px">
      <el-form label-width="70px">
        <el-form-item :label="partnerLabel" required><el-input v-model="quick.name" placeholder="名称" /></el-form-item>
        <el-form-item label="联系人"><el-input v-model="quick.contact" /></el-form-item>
        <el-form-item label="电话"><el-input v-model="quick.phone" /></el-form-item>
        <el-form-item label="地址"><el-input v-model="quick.address" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="quick.remark" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="quickVisible = false">取消</el-button>
        <el-button type="primary" :loading="quickSaving" @click="saveQuickPartner">保存</el-button>
      </template>
    </el-dialog>

    <!-- 查看详情 -->
    <el-dialog v-model="detailVisible" :title="'单据详情：' + detail.order_no" width="760px">
      <el-descriptions :column="3" border size="small">
        <el-descriptions-item :label="partnerLabel">{{ detail.partner_name }}</el-descriptions-item>
        <el-descriptions-item label="仓库">{{ detail.warehouse_name }}</el-descriptions-item>
        <el-descriptions-item label="日期">{{ detail.order_date }}</el-descriptions-item>
        <el-descriptions-item label="金额">{{ detail.total_amount }} 元</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="detail.status === 'done' ? 'success' : 'info'" size="small">{{ detail.status === 'done' ? '正常' : '已作废' }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="备注">{{ detail.remark || '—' }}</el-descriptions-item>
      </el-descriptions>
      <el-table :data="detail.items || []" border size="small" style="margin-top:10px">
        <el-table-column prop="product_name" label="商品" min-width="150" />
        <el-table-column prop="quantity" label="数量" width="90" />
        <el-table-column prop="unit_name" label="单位" width="80" />
        <el-table-column label="折算基准" width="110">
          <template #default="{ row }">{{ row.quantity_base }}</template>
        </el-table-column>
        <el-table-column prop="unit_price" label="单价" width="90" />
        <el-table-column prop="amount" label="金额" width="100" />
        <el-table-column prop="remark" label="备注" show-overflow-tooltip />
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';
import CustomFields from '../components/CustomFields.vue';

const props = defineProps({ kind: { type: String, default: 'purchase' } });
const kindText = computed(() => props.kind === 'purchase' ? '进货' : '出货');
const partnerLabel = computed(() => props.kind === 'purchase' ? '供应商' : '客户');
const baseUrl = computed(() => props.kind === 'purchase' ? '/purchase-orders' : '/sales-orders');
const partnerField = computed(() => props.kind === 'purchase' ? 'supplier_id' : 'customer_id');

const rows = ref([]);
const partners = ref([]);
const warehouses = ref([]);
const products = ref([]);
const units = ref([]);
const range = ref([]);
const query = reactive({ partnerId: '', keyword: '' });
const createVisible = ref(false);
const detailVisible = ref(false);
const detail = ref({});
const saving = ref(false);
const draft = reactive(emptyDraft());
const quickVisible = ref(false);
const quickSaving = ref(false);
const quick = reactive({ name: '', contact: '', phone: '', address: '', remark: '' });

const countUnits = computed(() => units.value.filter(u => u.dimension === 'count' && u.active));

function emptyDraft() {
  return {
    partner_id: null, warehouse_id: null, order_date: new Date().toISOString().slice(0, 10),
    remark: '', custom_data: {}, items: [{ product_id: null, unit_id: null, quantity: 1, unit_price: 0 }]
  };
}

async function loadPartners() {
  partners.value = await api.get(props.kind === 'purchase' ? '/suppliers' : '/customers');
}
async function load() {
  const [o, w] = await Promise.all([
    api.get(baseUrl.value, { params: { ...query, from: range.value?.[0] || '', to: range.value?.[1] || '' } }),
    api.get('/warehouses')
  ]);
  rows.value = o; warehouses.value = w;
  await loadPartners();
}
function openQuickPartner() {
  Object.assign(quick, { name: '', contact: '', phone: '', address: '', remark: '' });
  quickVisible.value = true;
}
async function saveQuickPartner() {
  if (!quick.name) return ElMessage.warning('请输入名称');
  quickSaving.value = true;
  try {
    const r = await api.post(props.kind === 'purchase' ? '/suppliers' : '/customers', quick);
    ElMessage.success('已新增');
    quickVisible.value = false;
    await loadPartners();
    draft.partner_id = r.id;
  } catch (e) { ElMessage.error(e.response?.data?.error || '保存失败'); }
  finally { quickSaving.value = false; }
}
async function loadRefs() {
  const [p, u] = await Promise.all([api.get('/products'), api.get('/units')]);
  products.value = p; units.value = u;
}
function openCreate() {
  Object.assign(draft, emptyDraft());
  createVisible.value = true;
  loadRefs();
}
function addLine() { draft.items.push({ product_id: null, unit_id: null, quantity: 1, unit_price: 0 }); }
function onProductChange(row) {
  const p = products.value.find(x => x.id === row.product_id);
  row.unit_id = p?.base_unit_id ?? null;
  if (p && !row.unit_price) row.unit_price = props.kind === 'purchase' ? p.purchase_price : p.sale_price;
}
function lineAmount(row) {
  return ((Number(row.quantity) || 0) * (Number(row.unit_price) || 0)).toFixed(2);
}
function lineWeight(row) {
  const p = products.value.find(x => x.id === row.product_id);
  const u = units.value.find(x => x.id === row.unit_id);
  if (!p || !u || !p.weight_per_base_kg) return '0';
  return ((Number(row.quantity) || 0) * u.ratio * p.weight_per_base_kg).toFixed(2);
}
const totalAmount = computed(() => draft.items.reduce((s, r) => s + (Number(r.quantity) || 0) * (Number(r.unit_price) || 0), 0).toFixed(2));
const totalWeight = computed(() => draft.items.reduce((s, r) => s + Number(lineWeight(r)), 0).toFixed(2));

async function submit() {
  if (!draft.partner_id) return ElMessage.warning('请选择' + partnerLabel.value);
  if (!draft.warehouse_id) return ElMessage.warning('请选择仓库');
  const items = draft.items.filter(r => r.product_id);
  if (!items.length) return ElMessage.warning('请至少添加一条商品明细');
  for (const r of items) {
    if (!r.unit_id) return ElMessage.warning('请为每条明细选择单位');
    if (!(Number(r.quantity) > 0)) return ElMessage.warning('数量必须大于 0');
  }
  saving.value = true;
  try {
    const body = {
      supplier_id: props.kind === 'purchase' ? draft.partner_id : undefined,
      customer_id: props.kind === 'sales' ? draft.partner_id : undefined,
      warehouse_id: draft.warehouse_id, order_date: draft.order_date, remark: draft.remark,
      custom_data: draft.custom_data, items
    };
    const r = await api.post(baseUrl.value, body);
    ElMessage.success(`保存成功，单号 ${r.order_no}`);
    createVisible.value = false; load();
  } catch (e) { ElMessage.error(e.response?.data?.error || '保存失败'); }
  finally { saving.value = false; }
}
async function openDetail(row) {
  detail.value = await api.get(baseUrl.value + '/' + row.id);
  detailVisible.value = true;
}
async function voidOrder(row) {
  await ElMessageBox.confirm(`确定作废单号 ${row.order_no} 吗？库存将自动冲回。`, '作废确认', { type: 'warning' });
  await api.post(baseUrl.value + '/' + row.id + '/void');
  ElMessage.success('已作废'); load();
}
onMounted(load);
</script>

<style scoped>
.toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
.total-bar { margin-top: 10px; background: #f5f7fa; padding: 8px 12px; border-radius: 4px; font-size: 14px; }
</style>
