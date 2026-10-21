<template>
  <div v-if="action" class="ai-action" :class="[`is-${action.status || 'proposed'}`, { 'is-danger-action': isDangerAction }]">
    <div class="ai-action-head">
      <b>{{ title }}</b>
      <el-tag size="small" :type="tagType">{{ statusText }}</el-tag>
    </div>

    <template v-if="preview.kind === 'stock_adjustment'">
      <div class="ai-action-meta">
        <span>商品：{{ preview.product_name }}<template v-if="preview.product_spec">（{{ preview.product_spec }}）</template></span>
        <span>仓库：{{ preview.warehouse_name }}</span>
      </div>
      <div class="ai-adjust">
        <div class="ai-adjust-num">
          <span class="label">调整前</span>
          <b>{{ qty(preview.before) }} {{ preview.base_unit_name }}</b>
        </div>
        <div class="ai-adjust-num">
          <span class="label">调整</span>
          <b :class="Number(preview.delta_qty) >= 0 ? 'up' : 'down'">
            {{ Number(preview.delta_qty) > 0 ? '+' : '' }}{{ qty(preview.delta_qty) }} {{ preview.unit_name }}
          </b>
        </div>
        <div class="ai-adjust-num">
          <span class="label">调整后</span>
          <b :class="Number(preview.after) < 0 ? 'down' : ''">{{ qty(preview.after) }} {{ preview.base_unit_name }}</b>
        </div>
      </div>
      <div class="ai-action-remark">原因：{{ preview.reason }}</div>
    </template>

    <template v-else>
      <div class="ai-action-meta">
        <template v-if="preview.kind === 'void_order'">
          <span>单号：{{ preview.order_no }}</span>
          <span>日期：{{ preview.order_date }}</span>
          <span>往来单位：{{ preview.partner_name }}</span>
          <span>仓库：{{ preview.warehouse_name }}</span>
        </template>
        <template v-else-if="preview.kind === 'update_order'">
          <span>单号：{{ preview.order_no }}</span>
          <span>日期：{{ dateText }}</span>
          <span>往来单位：{{ partnerChangeText }}</span>
          <span>仓库：{{ preview.warehouse_name }}</span>
        </template>
        <template v-else>
          <span>{{ partnerLabel }}：{{ partnerName }}</span>
          <span>仓库：{{ preview.warehouse_name }}</span>
          <span>日期：{{ preview.order_date }}</span>
        </template>
      </div>

      <el-table :data="preview.items || []" size="small" border max-height="220" style="width:100%">
        <el-table-column prop="product_name" label="商品" show-overflow-tooltip />
        <el-table-column prop="product_spec" label="规格" width="70" />
        <el-table-column label="数量" width="80">
          <template #default="{ row }">{{ qty(row.quantity) }}</template>
        </el-table-column>
        <el-table-column prop="unit_name" label="单位" width="60" />
        <el-table-column label="单价" width="80">
          <template #default="{ row }">{{ money(row.unit_price) }}</template>
        </el-table-column>
        <el-table-column label="金额" width="90">
          <template #default="{ row }">{{ money(row.amount) }}</template>
        </el-table-column>
      </el-table>

      <div v-if="preview.kind === 'void_order'" class="ai-action-total">
        原单合计：<b>{{ money(preview.total_amount) }}</b> 元
      </div>
      <div v-else-if="preview.kind === 'update_order'" class="ai-action-total">
        原合计 {{ money(preview.old_total_amount) }} 元 → 新合计 <b>{{ money(preview.total_amount) }}</b> 元
      </div>
      <div v-else class="ai-action-total">合计：<b>{{ money(preview.total_amount) }}</b> 元</div>

      <details v-if="preview.kind === 'update_order' && preview.items_changed" class="ai-old-items">
        <summary>修改前明细（合计 {{ money(preview.old_total_amount) }} 元）</summary>
        <el-table :data="preview.old_items || []" size="small" border max-height="180" style="width:100%;margin-top:6px">
          <el-table-column prop="product_name" label="商品" show-overflow-tooltip />
          <el-table-column label="数量" width="80">
            <template #default="{ row }">{{ qty(row.quantity) }}</template>
          </el-table-column>
          <el-table-column prop="unit_name" label="单位" width="60" />
          <el-table-column label="单价" width="80">
            <template #default="{ row }">{{ money(row.unit_price) }}</template>
          </el-table-column>
          <el-table-column label="金额" width="90">
            <template #default="{ row }">{{ money(row.amount) }}</template>
          </el-table-column>
        </el-table>
      </details>

      <div v-if="preview.kind === 'void_order'" class="ai-action-remark">作废原因：{{ preview.reason }}</div>
      <div v-else-if="preview.remark" class="ai-action-remark">备注：{{ preview.remark }}</div>
    </template>

    <div v-if="preview.kind !== 'stock_adjustment' && (preview.stock_changes || []).length" class="ai-action-stock">
      <div class="ai-action-subtitle">库存变化</div>
      <el-table :data="preview.stock_changes || []" size="small" border max-height="180" style="width:100%">
        <el-table-column prop="product_name" label="商品" show-overflow-tooltip />
        <el-table-column prop="warehouse_name" label="仓库" width="90" />
        <el-table-column label="变更前" width="80">
          <template #default="{ row }">{{ qty(row.before) }}</template>
        </el-table-column>
        <el-table-column label="变更" width="80">
          <template #default="{ row }">{{ Number(row.delta) > 0 ? '+' : '' }}{{ qty(row.delta) }}</template>
        </el-table-column>
        <el-table-column label="变更后" width="80">
          <template #default="{ row }">{{ qty(row.after) }}</template>
        </el-table-column>
        <el-table-column prop="unit_name" label="单位" width="60" />
      </el-table>
    </div>

    <el-alert
      v-if="(action.warnings || []).length"
      type="warning"
      :closable="false"
      title="请确认"
      :description="(action.warnings || []).join('；')"
      style="margin-top:8px"
    />
    <el-alert
      v-if="action.error"
      type="error"
      :closable="false"
      :title="action.error"
      style="margin-top:8px"
    />
    <div v-if="action.status === 'confirmed'" class="ai-action-success">
      {{ successText }}<template v-if="action.result?.order_no">：单号 <b>{{ action.result.order_no }}</b></template>
      <template v-if="action.backup">；已自动备份 {{ action.backup }}</template>
    </div>
    <div v-if="canConfirm" class="ai-action-tip">确认后才会写入；写入前会自动备份。</div>
    <div v-else-if="canAct && !canConfirm" class="ai-action-tip" style="color:#e6a23c">
      当前权限不足或已失效，请重新授权后再确认；仍可取消。
    </div>

    <div class="ai-action-footer">
      <span class="ai-action-expire">{{ expiryText }}</span>
      <div>
        <el-button v-if="canAct" size="small" :disabled="busy" @click="$emit('cancel')">取消</el-button>
        <el-button v-if="canConfirm" size="small" type="danger" :loading="busy" @click="$emit('confirm')">{{ confirmLabel }}</el-button>
        <el-button v-if="action.status === 'confirmed'" size="small" type="primary" plain @click="goList">查看单据</el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';

const props = defineProps({
  action: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  canWrite: { type: Boolean, default: true },
  canDanger: { type: Boolean, default: false }
});
defineEmits(['confirm', 'cancel']);

const router = useRouter();
const now = ref(Date.now());
let timer = null;

onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onUnmounted(() => { if (timer) clearInterval(timer); });

const preview = computed(() => props.action?.preview || {});
const isDangerAction = computed(() => ['void_order', 'update_order'].includes(props.action?.type)
  || ['void_order', 'update_order'].includes(preview.value.kind));
const title = computed(() => {
  if (preview.value.kind === 'stock_adjustment') return '待确认的库存调整';
  if (preview.value.kind === 'void_order') return '待确认的作废';
  if (preview.value.kind === 'update_order') return '待确认的改单';
  if (preview.value.kind === 'sales_order') return '待确认的出货单';
  return '待确认的进货单';
});
const partnerLabel = computed(() => {
  if (preview.value.kind === 'sales_order') return '客户';
  if (preview.value.kind === 'purchase_order') return '供应商';
  return '往来单位';
});
const partnerName = computed(() => {
  if (preview.value.kind === 'void_order' || preview.value.kind === 'update_order') return preview.value.partner_name || '';
  return preview.value.kind === 'sales_order'
    ? (preview.value.customer_name || '')
    : (preview.value.supplier_name || '');
});
const dateText = computed(() => {
  if (preview.value.kind === 'update_order' && preview.value.old_order_date && preview.value.old_order_date !== preview.value.order_date) {
    return `${preview.value.old_order_date} → ${preview.value.order_date}`;
  }
  return preview.value.order_date || '';
});
const partnerChangeText = computed(() => {
  if (preview.value.kind === 'update_order' && preview.value.old_partner_name && preview.value.old_partner_name !== preview.value.partner_name) {
    return `${preview.value.old_partner_name} → ${preview.value.partner_name}`;
  }
  return preview.value.partner_name || '';
});

const expired = computed(() => {
  if (props.action?.status !== 'proposed') return false;
  const t = props.action?.expires_at ? new Date(props.action.expires_at).getTime() : 0;
  return !!t && t <= now.value;
});
const canAct = computed(() => props.action?.status === 'proposed' && !expired.value);
const canConfirm = computed(() => canAct.value && (isDangerAction.value ? props.canDanger : props.canWrite));
const confirmLabel = computed(() => {
  if (preview.value.kind === 'void_order') return '确认作废';
  if (preview.value.kind === 'update_order') return '确认改单';
  return '确认执行';
});
const successText = computed(() => {
  if (preview.value.kind === 'void_order') return '已作废';
  if (preview.value.kind === 'update_order') return '已修改';
  return '已执行';
});
const statusText = computed(() => {
  if (expired.value) return '已过期';
  return {
    proposed: '待确认',
    confirming: '执行中',
    confirmed: '已执行',
    cancelled: '已取消',
    failed: '失败',
    expired: '已过期'
  }[props.action?.status] || props.action?.status || '';
});
const tagType = computed(() => {
  if (expired.value) return 'info';
  if (props.action?.status === 'proposed' && isDangerAction.value) return 'danger';
  return {
    proposed: 'warning',
    confirming: 'info',
    confirmed: 'success',
    cancelled: 'info',
    failed: 'danger',
    expired: 'info'
  }[props.action?.status] || 'info';
});
const expiryText = computed(() => {
  if (props.action?.status !== 'proposed') return '';
  if (expired.value) return '已过期';
  if (!props.action?.expires_at) return '';
  const left = Math.max(0, Math.ceil((new Date(props.action.expires_at).getTime() - now.value) / 1000));
  const m = String(Math.floor(left / 60)).padStart(2, '0');
  const s = String(left % 60).padStart(2, '0');
  return `确认剩余 ${m}:${s}`;
});

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}
function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : String(v ?? '');
}
function goList() {
  const kind = preview.value.kind;
  const orderKind = preview.value.order_kind;
  if (kind === 'purchase_order' || orderKind === 'purchase') router.push('/purchase');
  else if (kind === 'sales_order' || orderKind === 'sales') router.push('/sales');
  else router.push('/stock');
}
</script>

<style scoped>
.ai-action { margin-top: 10px; border: 1px solid #f0c78a; background: #fffaf2; border-radius: 8px; padding: 10px; }
.ai-action.is-danger-action { border-color: #f56c6c; background: #fef0f0; }
.ai-action.is-confirmed { border-color: #b3e19d; background: #f0f9eb; }
.ai-action.is-failed, .ai-action.is-expired, .ai-action.is-cancelled { border-color: #e5e7eb; background: #f7f8fa; }
.ai-old-items { margin-top: 8px; font-size: 12px; color: #606266; }
.ai-old-items summary { cursor: pointer; user-select: none; }
.ai-action-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-size: 13px; }
.ai-action-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: #606266; margin-bottom: 8px; }
.ai-adjust { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 8px 0; }
.ai-adjust-num { background: #fff; border: 1px solid #f0e0c8; border-radius: 6px; padding: 8px; }
.ai-adjust-num .label { display: block; font-size: 11px; color: #909399; margin-bottom: 2px; }
.ai-adjust-num b { font-size: 14px; }
.up { color: #67c23a; }
.down { color: #f56c6c; }
.ai-action-total { text-align: right; font-size: 13px; margin-top: 6px; }
.ai-action-total b { color: #c45656; font-size: 15px; }
.ai-action-stock { margin-top: 8px; }
.ai-action-subtitle { font-size: 12px; color: #909399; margin: 4px 0; }
.ai-action-remark { font-size: 12px; color: #606266; margin-top: 6px; }
.ai-action-success { font-size: 12px; color: #529b2e; margin-top: 8px; }
.ai-action-tip { font-size: 11px; color: #909399; margin-top: 8px; }
.ai-action-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
.ai-action-expire { font-size: 11px; color: #909399; }
</style>