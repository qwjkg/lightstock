<template>
  <div v-if="card" class="ai-card">
    <div v-if="card.title" class="ai-card-title">{{ card.title }}</div>

    <div v-if="card.type === 'metrics'" class="ai-metrics">
      <div v-for="(m, i) in card.metrics || []" :key="i" class="ai-metric">
        <div class="ai-metric-label">{{ m.label }}</div>
        <div class="ai-metric-value">{{ fmt(m.value, m.format, m.unit) }}</div>
      </div>
    </div>

    <el-table
      v-else-if="card.type === 'table'"
      :data="card.rows || []"
      size="small"
      border
      max-height="280"
      style="width:100%"
    >
      <el-table-column
        v-for="c in card.columns || []"
        :key="c.prop"
        :prop="c.prop"
        :label="c.label"
        :width="c.width"
        show-overflow-tooltip
      >
        <template #default="{ row }">{{ fmt(row[c.prop], c.format, c.unit) }}</template>
      </el-table-column>
      <template #empty>没有数据</template>
    </el-table>

    <el-alert
      v-else-if="card.type === 'warning'"
      type="warning"
      :closable="false"
      :title="card.title || '提示'"
      :description="card.text || ''"
    />

    <div v-else-if="card.type === 'chart'" class="ai-chart-placeholder">
      图表数据已返回，可在「报表统计」中查看完整图表。
    </div>

    <div v-if="card.note" class="ai-card-note">{{ card.note }}</div>
  </div>
</template>

<script setup>
const props = defineProps({ card: { type: Object, default: null } });

function num(v) { return Number(v); }
function fmt(value, kind, unit) {
  if (value === null || value === undefined || value === '') return '—';
  if (kind === 'money') {
    const n = num(value);
    return Number.isFinite(n)
      ? '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : String(value);
  }
  if (kind === 'qty') {
    const n = num(value);
    const s = Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : String(value);
    return unit ? `${s} ${unit}` : s;
  }
  if (kind === 'int') {
    const n = num(value);
    return Number.isFinite(n) ? n.toLocaleString('zh-CN') : String(value);
  }
  return value;
}
</script>

<style scoped>
.ai-card { margin-top: 8px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; background: #fff; }
.ai-card-title { font-size: 13px; font-weight: 600; color: #303133; margin-bottom: 8px; }
.ai-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.ai-metric { background: #f7f8fa; border-radius: 6px; padding: 8px; }
.ai-metric-label { font-size: 12px; color: #909399; }
.ai-metric-value { font-size: 16px; font-weight: 600; color: #303133; margin-top: 2px; word-break: break-all; }
.ai-card-note { font-size: 12px; color: #909399; line-height: 1.5; margin-top: 8px; }
.ai-chart-placeholder { font-size: 12px; color: #909399; padding: 8px 0; }
</style>