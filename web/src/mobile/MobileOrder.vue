<template>
  <div class="m-order">
    <!-- 客户 -->
    <button class="m-pick" @click="customerOpen = true">
      <span class="m-pick-label">客户</span>
      <span class="m-pick-value" :class="{ empty: !customerName }">{{ customerName || '点这里选择客户' }}</span>
      <span class="m-arrow">›</span>
    </button>
    <div v-if="isEdit" class="m-edit-tip">正在修改出货单 {{ orderNo }}</div>

    <!-- 常卖商品 -->
    <div class="m-section-title">常卖商品</div>
    <div v-if="suggest.length" class="m-chips">
      <button v-for="s in suggest.slice(0, 12)" :key="s.product_id" class="m-sugg" @click="addProduct(s.product_id)">
        {{ s.name }}<span v-if="s.last_price != null" class="m-sugg-price">{{ s.last_price }}</span>
      </button>
    </div>
    <button class="m-add-product" @click="openProductPicker">+ 搜索商品</button>

    <!-- 明细 -->
    <div class="m-section-title">已选 {{ draft.items.length }} 项</div>
    <div v-if="!draft.items.length" class="m-empty-small">
      还没有商品。点上面的常卖标签，或「搜索商品」。
    </div>
    <ul class="m-lines">
      <li v-for="(it, i) in draft.items" :key="i" class="m-line">
        <div class="m-line-head">
          <span class="m-line-name">{{ productName(it.product_id) }}</span>
          <button class="m-del" @click="draft.items.splice(i, 1)">删除</button>
        </div>
        <div class="m-line-row">
          <div class="m-stepper">
            <button @click="step(it, -1)">−</button>
            <input v-model.number="it.quantity" type="number" inputmode="decimal" min="0" />
            <button @click="step(it, 1)">＋</button>
          </div>
          <label class="m-price">
            <span>￥</span>
            <input v-model.number="it.unit_price" type="number" inputmode="decimal" min="0" />
          </label>
          <span class="m-amount">{{ lineAmount(it) }}</span>
        </div>
      </li>
    </ul>

    <input v-model="draft.remark" class="m-remark" placeholder="备注（可选）" />

    <!-- 底部合计 / 保存 -->
    <div class="m-bottom">
      <div class="m-total">合计 <b>{{ totalAmount }}</b> 元</div>
      <button class="m-save" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : (isEdit ? '保存修改' : '保存出货单') }}
      </button>
    </div>

    <!-- 客户选择（全屏抽屉） -->
    <div v-if="customerOpen" class="m-drawer">
      <div class="m-drawer-head">
        <input v-model="customerSearch" class="m-input" placeholder="搜索客户" />
        <button class="m-close" @click="customerOpen = false">关闭</button>
      </div>
      <ul class="m-drawer-list">
        <li v-for="c in filteredCustomers" :key="c.id" @click="pickCustomer(c)">
          {{ c.name }}<span v-if="c.phone" class="m-sub">{{ c.phone }}</span>
        </li>
        <li v-if="!filteredCustomers.length" class="m-drawer-empty">没有匹配的客户</li>
      </ul>
    </div>

    <!-- 商品选择（全屏抽屉） -->
    <div v-if="productOpen" class="m-drawer">
      <div class="m-drawer-head">
        <input v-model="productSearch" class="m-input" placeholder="搜索商品名称 / 编号" />
        <button class="m-close" @click="productOpen = false">关闭</button>
      </div>
      <ul class="m-drawer-list">
        <li v-for="p in filteredProducts" :key="p.id" @click="pickProduct(p)">
          {{ p.name }}<span v-if="p.spec" class="m-sub">{{ p.spec }}</span>
        </li>
        <li v-if="!filteredProducts.length" class="m-drawer-empty">没有匹配的商品</li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';
import { errorText } from '../ui';

const route = useRoute();
const router = useRouter();

const orderId = computed(() => (route.params.id ? Number(route.params.id) : null));
const isEdit = computed(() => !!orderId.value);
const orderNo = ref('');

const customers = ref([]);
const warehouses = ref([]);
const products = ref([]);
const units = ref([]);
const suggest = ref([]);

const customerOpen = ref(false);
const productOpen = ref(false);
const customerSearch = ref('');
const productSearch = ref('');
const saving = ref(false);

const draft = reactive({
  customer_id: null,
  warehouse_id: null,
  order_date: new Date().toISOString().slice(0, 10),
  remark: '',
  items: []
});

const customerName = computed(() => customers.value.find(c => c.id === draft.customer_id)?.name || '');
const filteredCustomers = computed(() => {
  const k = customerSearch.value.trim();
  return k ? customers.value.filter(c => c.name.includes(k) || (c.phone || '').includes(k)) : customers.value;
});
const filteredProducts = computed(() => {
  const k = productSearch.value.trim();
  if (!k) return products.value.slice(0, 50);
  return products.value.filter(p => p.name.includes(k) || (p.sku || '').includes(k) || (p.barcode || '').includes(k)).slice(0, 50);
});
const totalAmount = computed(() =>
  draft.items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0), 0).toFixed(2)
);

function productName(id) {
  return products.value.find(p => p.id === id)?.name || '—';
}
function unitOf(id) {
  return units.value.find(u => u.id === id);
}
function defaultUnitId() {
  return units.value.find(u => u.dimension === 'count' && u.is_base)?.id
    ?? units.value.find(u => u.dimension === 'count')?.id ?? null;
}
function lineAmount(it) {
  return ((Number(it.quantity) || 0) * (Number(it.unit_price) || 0)).toFixed(2);
}
function step(it, dir) {
  // 按斤/公斤卖的货，步进 0.5；按件卖的步进 1
  const u = unitOf(it.unit_id);
  const size = u && u.dimension === 'weight' ? 0.5 : 1;
  const v = Math.round(((Number(it.quantity) || 0) + dir * size) * 1000) / 1000;
  it.quantity = Math.max(0, v);
}

async function loadSuggest() {
  try {
    const r = await api.get('/order-suggest', { params: { kind: 'sales', partnerId: draft.customer_id || '' } });
    suggest.value = r.products || [];
  } catch { suggest.value = []; }
}

function pickCustomer(c) {
  draft.customer_id = c.id;
  customerOpen.value = false;
  customerSearch.value = '';
  loadSuggest();
}
function addProduct(productId, unitPrice) {
  const p = products.value.find(x => x.id === productId);
  if (!p) return;
  const s = suggest.value.find(x => x.product_id === productId);
  draft.items.push({
    product_id: productId,
    unit_id: p.base_unit_id || defaultUnitId(),
    quantity: 1,
    unit_price: unitPrice != null ? unitPrice
      : (s && s.last_price != null ? s.last_price : (p.sale_price || 0))
  });
}
function openProductPicker() {
  productSearch.value = '';
  productOpen.value = true;
}
function pickProduct(p) {
  addProduct(p.id);
  productOpen.value = false;
  productSearch.value = '';
}

async function loadOrder() {
  const d = await api.get('/sales-orders/' + orderId.value);
  orderNo.value = d.order_no;
  if (d.status !== 'done') {
    ElMessage.warning('这张单已作废，不能修改');
    router.replace('/m/orders');
    return;
  }
  draft.customer_id = d.customer_id;
  draft.warehouse_id = d.warehouse_id;
  draft.order_date = d.order_date;
  draft.remark = d.remark || '';
  draft.items = (d.items || []).map(i => ({
    product_id: i.product_id, unit_id: i.unit_id, quantity: i.quantity, unit_price: i.unit_price
  }));
  if (!draft.items.length) draft.items.push({ product_id: null, unit_id: null, quantity: 1, unit_price: 0 });
}

async function save() {
  if (!draft.customer_id) return ElMessage.warning('请先选择客户');
  if (!draft.warehouse_id) return ElMessage.warning('没有可用的仓库');
  const items = draft.items.filter(it => it.product_id && Number(it.quantity) > 0);
  if (!items.length) return ElMessage.warning('请至少添加一件商品');

  saving.value = true;
  try {
    const body = {
      customer_id: draft.customer_id,
      warehouse_id: draft.warehouse_id,
      order_date: draft.order_date,
      remark: draft.remark,
      items: items.map(it => ({
        product_id: it.product_id, unit_id: it.unit_id,
        quantity: Number(it.quantity), unit_price: Number(it.unit_price) || 0
      }))
    };
    const r = isEdit.value
      ? await api.put('/sales-orders/' + orderId.value, body)
      : await api.post('/sales-orders', body);
    if (r.warning) {
      await ElMessageBox.alert(r.warning, '已保存，请注意', { confirmButtonText: '知道了' });
    }
    ElMessage.success(isEdit.value ? '已保存修改' : '出货单已保存');
    router.replace('/m/orders');
  } catch (e) {
    ElMessage.error(errorText(e, '保存失败'));
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    const [c, w, p, u] = await Promise.all([
      api.get('/customers'), api.get('/warehouses'), api.get('/products'), api.get('/units')
    ]);
    customers.value = c;
    warehouses.value = w;
    products.value = p;
    units.value = u;
    if (warehouses.value.length === 1) draft.warehouse_id = warehouses.value[0].id;
    if (isEdit.value) await loadOrder();
    await loadSuggest();
  } catch (e) {
    ElMessage.error(errorText(e, '数据加载失败'));
  }
});
</script>

<style scoped>
.m-order {
  padding: 12px 12px calc(150px + env(safe-area-inset-bottom, 0px));
}
.m-pick {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  background: #fff;
  border: none;
  border-radius: 10px;
  padding: 16px 14px;
  min-height: 56px;
  font-size: 16px;
  text-align: left;
}
.m-pick-label { color: #909399; font-size: 13px; flex: 0 0 auto; }
.m-pick-value { flex: 1; color: #303133; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m-pick-value.empty { color: #c0c4cc; font-weight: 400; }
.m-arrow { color: #c0c4cc; font-size: 20px; }
.m-edit-tip { margin-top: 8px; color: #e6a23c; font-size: 13px; text-align: center; }

.m-section-title { margin: 16px 4px 8px; color: #909399; font-size: 12px; }
.m-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.m-sugg {
  min-height: 40px;
  padding: 8px 12px;
  border: 1px solid #dcdfe6;
  border-radius: 20px;
  background: #fff;
  color: #303133;
  font-size: 14px;
}
.m-sugg:active { background: #ecf5ff; border-color: #0f5ac9; }
.m-sugg-price { color: #e6a23c; margin-left: 6px; }
.m-add-product {
  width: 100%;
  margin-top: 10px;
  min-height: 44px;
  border: 1px dashed #c0c4cc;
  border-radius: 8px;
  background: transparent;
  color: #606266;
  font-size: 14px;
}
.m-empty-small { color: #909399; font-size: 13px; padding: 8px 4px 12px; line-height: 1.6; }

.m-lines { list-style: none; margin: 0; padding: 0; }
.m-line { background: #fff; border-radius: 10px; padding: 12px; margin-bottom: 8px; }
.m-line-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.m-line-name { font-size: 15px; font-weight: 600; color: #303133; flex: 1; word-break: break-all; }
.m-del { flex: 0 0 auto; border: none; background: transparent; color: #f56c6c; font-size: 13px; padding: 4px; }
.m-line-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.m-stepper {
  display: flex; align-items: center; flex: 0 0 auto;
  border: 1px solid #dcdfe6; border-radius: 8px; overflow: hidden;
}
.m-stepper button {
  flex: 0 0 34px; width: 34px; height: 38px; border: none; background: #f5f7fa;
  font-size: 20px; color: #606266; padding: 0;
}
.m-stepper input {
  flex: 0 0 44px; width: 44px; height: 38px; border: none; text-align: center;
  font-size: 16px; outline: none; min-width: 0;
  /* 去掉数字框的上下箭头，手机上没用还占地方 */
  -moz-appearance: textfield;
}
.m-stepper input::-webkit-outer-spin-button,
.m-stepper input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.m-price {
  flex: 1 1 0%; min-width: 0;
  display: flex; align-items: center; gap: 2px;
  border: 1px solid #dcdfe6; border-radius: 8px; padding: 0 8px; height: 38px;
}
.m-price span { color: #909399; font-size: 14px; flex: 0 0 auto; }
.m-price input {
  flex: 1 1 0%; min-width: 0; width: 100%;
  border: none; outline: none; font-size: 16px; text-align: right;
}
.m-amount { flex: 0 0 auto; width: 64px; text-align: right; font-weight: 700; color: #303133; }

.m-remark {
  width: 100%; box-sizing: border-box; margin-top: 10px; height: 44px;
  padding: 0 14px; font-size: 16px; border: 1px solid #dcdfe6;
  border-radius: 8px; background: #fff; outline: none;
}

.m-bottom {
  position: fixed; left: 0; right: 0;
  bottom: calc(56px + env(safe-area-inset-bottom, 0px));  /* 让开底部页签 */
  display: flex; align-items: center; gap: 12px;
  padding: 10px 12px; background: #fff; border-top: 1px solid #e5e7eb; z-index: 90;
}
.m-total { flex: 1; font-size: 14px; color: #606266; }
.m-total b { font-size: 20px; color: #f56c6c; }
.m-save {
  flex: 0 0 auto; min-height: 46px; padding: 0 24px;
  border: none; border-radius: 8px; background: #0f5ac9; color: #fff;
  font-size: 16px; font-weight: 600;
}
.m-save:disabled { opacity: .6; }

.m-drawer {
  position: fixed; inset: 0; background: #f5f7fa; z-index: 200;
  display: flex; flex-direction: column;
}
.m-drawer-head { display: flex; gap: 8px; padding: 12px; background: #fff; border-bottom: 1px solid #e5e7eb; }
.m-input {
  flex: 1; min-width: 0; height: 44px; padding: 0 14px; font-size: 16px;
  border: 1px solid #dcdfe6; border-radius: 8px; outline: none;
}
.m-close {
  flex: 0 0 auto; height: 44px; padding: 0 14px;
  border: 1px solid #dcdfe6; border-radius: 8px; background: #fff; color: #606266;
}
.m-drawer-list { flex: 1; overflow-y: auto; list-style: none; margin: 0; padding: 0; }
.m-drawer-list li {
  display: flex; justify-content: space-between; align-items: center;
  min-height: 56px; padding: 0 16px; background: #fff;
  border-bottom: 1px solid #f0f2f5; font-size: 16px;
}
.m-drawer-list li:active { background: #f5f7fa; }
.m-sub { color: #909399; font-size: 13px; margin-left: 8px; }
.m-drawer-empty { justify-content: center; color: #909399; }
</style>