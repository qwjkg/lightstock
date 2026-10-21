<template>
  <el-dialog
    :model-value="modelValue"
    title="AI 修改权限"
    width="min(500px, 92vw)"
    append-to-body
    class="ai-perm-dialog"
    @update:model-value="v => emit('update:modelValue', v)"
    @closed="stopHold"
  >
    <template v-if="isDanger">
      <el-alert
        type="error"
        :closable="false"
        title="当前已授权：高风险"
        :description="`有效至 ${expiresText}。可以作废/改单，但每次仍需在卡片上确认。`"
      />
      <ul class="perm-list">
        <li>可以：进货/出货/盘点，作废单据，修改单据</li>
        <li>作废不可撤销；改单会红冲后重记，库存/成本/毛利都会变化</li>
        <li>仍然不能：改商品资料、恢复备份、改密码、删数据</li>
      </ul>
      <el-button type="danger" plain :loading="busy" @click="lock">立即锁定</el-button>
    </template>

    <template v-else>
      <el-alert
        v-if="isWrite"
        type="success"
        :closable="false"
        title="当前已授权：可记账"
        description="可以继续升级到高风险（用于作废/改单），或立即锁定。"
      />
      <el-alert
        v-if="status.local_only"
        type="warning"
        :closable="false"
        title="AI 仅限本机使用"
        description="未设置访问密码时，AI 只能在本机使用。请先在设置中设置访问密码，再从手机/局域网使用。"
      />

      <template v-if="!status.local_only">
        <div v-if="!isWrite" class="perm-choice">
          <el-radio-group v-model="targetLevel">
            <el-radio-button value="write">可记账（15 分钟）</el-radio-button>
            <el-radio-button value="danger" :disabled="!status.password_required">高风险（5 分钟）</el-radio-button>
          </el-radio-group>
        </div>

        <template v-if="levelToGrant === 'danger'">
          <el-alert
            type="error"
            :closable="false"
            title="高风险操作"
            description="作废不可撤销；改单会红冲后重记，库存、成本、毛利都会变化。请确认你了解影响。"
            style="margin-top:10px"
          />
          <el-alert
            v-if="!status.password_required"
            type="warning"
            :closable="false"
            title="需要访问密码"
            description="请先在设置中设置访问密码，再开启高风险权限。"
            style="margin-top:8px"
          />
          <template v-else>
            <el-input
              v-model="password"
              type="password"
              show-password
              placeholder="请输入访问密码"
              style="margin-top:10px"
            />
            <el-input
              v-model="confirmText"
              placeholder="请输入确认词：确认高风险"
              style="margin-top:8px"
            />
          </template>
        </template>

        <template v-else>
          <ul class="perm-list">
            <li>可以：新建进货单、出货单、库存调整（盘点）</li>
            <li>每次写入仍需在卡片上点「确认执行」；写前会自动备份</li>
            <li>有效 15 分钟，可随时锁定；页面关闭、服务重启或超时都会自动回到只读</li>
          </ul>
          <el-input
            v-if="status.password_required"
            v-model="password"
            type="password"
            show-password
            placeholder="请输入访问密码"
            style="margin:10px 0"
          />
        </template>

        <div class="hold-wrap">
          <el-button
            type="danger"
            :disabled="!canGrant"
            @mousedown.prevent="startHold"
            @mouseup="stopHold"
            @mouseleave="stopHold"
            @touchstart.prevent="startHold"
            @touchend="stopHold"
            @touchcancel="stopHold"
          >
            {{ holding ? '继续按住…' : holdLabel }}
          </el-button>
          <el-progress :percentage="holdPct" :show-text="false" :stroke-width="6" />
        </div>
      </template>
      <el-button v-if="isWrite" link type="danger" style="margin-top:8px" @click="lock">
        立即锁定当前权限
      </el-button>
    </template>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { errorText } from '../ui';
import { grantAiPermission, lockAiPermission } from '../ai/useAi';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  status: { type: Object, default: () => ({}) },
  permission: { type: Object, default: () => ({ level: 'read' }) }
});
const emit = defineEmits(['update:modelValue', 'changed']);

const password = ref('');
const confirmText = ref('');
const targetLevel = ref('write');
const busy = ref(false);
const holding = ref(false);
const holdPct = ref(0);
let holdTimer = null;
let holdStartedAt = 0;

const isWrite = computed(() => props.permission?.level === 'write');
const isDanger = computed(() => props.permission?.level === 'danger');
const levelToGrant = computed(() => isWrite.value ? 'danger' : targetLevel.value);
const canGrant = computed(() => {
  if (busy.value || props.status?.local_only) return false;
  const level = levelToGrant.value;
  if (level === 'danger' && !props.status?.password_required) return false;
  if (props.status?.password_required && !password.value) return false;
  if (level === 'danger' && confirmText.value.trim() !== '确认高风险') return false;
  return true;
});
const holdLabel = computed(() => levelToGrant.value === 'danger'
  ? '按住 1.5 秒开启高风险'
  : '按住 1.5 秒确认授权');
const expiresText = computed(() => {
  if (!props.permission?.expires_at) return '';
  try { return new Date(props.permission.expires_at).toLocaleTimeString('zh-CN', { hour12: false }); }
  catch { return ''; }
});

function startHold() {
  if (!canGrant.value || holding.value) return;
  holding.value = true;
  holdStartedAt = Date.now();
  holdTimer = setInterval(() => {
    holdPct.value = Math.min(100, Math.round((Date.now() - holdStartedAt) / 1500 * 100));
    if (holdPct.value >= 100) {
      stopHold();
      grant();
    }
  }, 50);
}
function stopHold() {
  if (holdTimer) clearInterval(holdTimer);
  holdTimer = null;
  holding.value = false;
  holdPct.value = 0;
}
async function grant() {
  if (busy.value) return;
  const level = levelToGrant.value;
  busy.value = true;
  try {
    await grantAiPermission({
      level,
      minutes: level === 'danger' ? 5 : 15,
      password: password.value,
      confirm_text: level === 'danger' ? confirmText.value : ''
    });
    ElMessage.success(level === 'danger'
      ? '已开启高风险权限 5 分钟，作废/改单仍需逐次确认'
      : '已授权 AI 记账 15 分钟，每次写入仍需确认');
    emit('changed');
    emit('update:modelValue', false);
  } catch (e) {
    ElMessage.error(errorText(e, '授权失败'));
  } finally {
    busy.value = false;
  }
}
async function lock() {
  if (busy.value) return;
  busy.value = true;
  try {
    await lockAiPermission();
    ElMessage.success('已锁定，AI 回到只读');
    emit('changed');
    emit('update:modelValue', false);
  } catch (e) {
    ElMessage.error(errorText(e, '锁定失败'));
  } finally {
    busy.value = false;
  }
}

watch(() => props.modelValue, v => {
  if (v) {
    targetLevel.value = 'write';
    password.value = '';
    confirmText.value = '';
  } else {
    stopHold();
  }
});
onUnmounted(stopHold);
</script>

<style scoped>
.perm-choice { margin-bottom: 4px; }
.perm-list { margin: 10px 0; padding-left: 20px; color: #606266; font-size: 13px; line-height: 1.9; }
.hold-wrap { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.hold-wrap .el-button { width: 100%; }
:global(.ai-perm-dialog) { max-height: 90vh; }
:global(.ai-perm-dialog .el-dialog__body) { max-height: 66vh; overflow-y: auto; }
</style>