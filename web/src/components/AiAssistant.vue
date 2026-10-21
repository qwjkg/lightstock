<template>
  <el-tooltip v-if="!mobile" :content="isDanger ? 'AI 助手（高风险）' : isWrite ? 'AI 助手（可记账）' : 'AI 助手（只读）'" placement="left">
    <el-button class="ai-fab" type="primary" circle size="large" @click="open">
      <el-icon :size="22"><ChatDotRound /></el-icon>
    </el-button>
  </el-tooltip>

  <el-drawer
    v-model="aiOpen"
    direction="rtl"
    :size="mobile ? '100%' : '440px'"
    :with-header="false"
    append-to-body
    :class="['ai-drawer', { 'is-mobile': mobile }]"
  >
    <div class="ai-shell" :class="{ 'is-mobile': mobile }">
      <div v-if="isWriteLike" class="ai-write-bar" :class="{ 'is-danger': isDanger }"></div>
      <div class="ai-header">
        <div class="ai-title">
          <el-icon><MagicStick /></el-icon>
          <span>AI 助手</span>
        </div>
        <div class="ai-header-right">
          <el-button
            size="small"
            :type="isDanger ? 'danger' : 'warning'"
            plain
            @click="permissionOpen = true"
          >
            <el-icon><component :is="isWriteLike ? 'Unlock' : 'Lock'" /></el-icon>
            <span style="margin-left:3px">{{ isDanger ? `高风险 ${remainingText}` : isWrite ? `可记账 ${remainingText}` : '只读' }}</span>
          </el-button>
          <el-button v-if="isWriteLike" link size="small" @click="lockNow">锁定</el-button>
          <el-button link size="small" @click="clear">清空</el-button>
          <el-button link @click="close"><el-icon><Close /></el-icon></el-button>
        </div>
      </div>

      <div v-if="aiStatus && !aiStatus.enabled" class="ai-notice">
        <el-alert
          type="info"
          :closable="false"
          title="AI 助手已关闭"
          description="请到 设置 → AI 助手 打开后再使用。"
        />
        <el-button size="small" type="primary" plain @click="goSettings">打开设置</el-button>
      </div>
      <div v-else-if="aiStatus && !aiStatus.configured" class="ai-notice">
        <el-alert
          type="warning"
          :closable="false"
          title="AI 未配置"
          description="请到 设置 → AI 助手 填写 DeepSeek API Key，或设置 AI_API_KEY 环境变量。"
        />
        <el-button size="small" type="primary" plain @click="goSettings">打开设置</el-button>
      </div>
      <div v-else-if="localOnly" class="ai-notice">
        <el-alert
          type="warning"
          :closable="false"
          title="AI 仅限本机使用"
          description="还没有设置访问密码。为防止局域网其他人使用你的 API Key，请先在设置中设置访问密码，再从手机/局域网使用。"
        />
        <el-button size="small" type="primary" plain @click="goSettings">打开设置</el-button>
      </div>

      <div ref="messagesRef" class="ai-messages">
        <div v-if="!messages.length" class="ai-empty">
          <div class="ai-empty-title">我能帮你查库存、算价值、找低库存、看毛利。</div>
          <div class="ai-suggestions">
            <el-button v-for="q in suggestions" :key="q" size="small" plain :disabled="!canUse" @click="send(q)">{{ q }}</el-button>
          </div>
          <div class="ai-empty-tip">
            {{ isDanger ? '当前高风险：可以作废/改单，但每次都要你点确认；作废不可撤销。' : isWrite ? '当前可记账：AI 可以生成待确认单据，但每次都要你点「确认执行」。' : '当前只读；所有数字来自本机账本，查不到会直接说查不到。' }}
          </div>
        </div>

        <div v-for="(m, i) in messages" :key="i" :class="['ai-msg', m.role]">
          <div class="ai-bubble">
            <div class="ai-text">{{ m.content }}</div>
            <AiDataCard v-for="(c, ci) in (m.cards || [])" :key="ci" :card="c" />
            <AiActionCard
              v-for="(a, ai) in (m.actions || [])"
              :key="a.action_id || ai"
              :action="a"
              :busy="workingAction === a.action_id"
              :can-write="isWriteLike"
              :can-danger="isDanger"
              @confirm="onConfirmAction(a)"
              @cancel="onCancelAction(a)"
            />
            <details v-if="m.tool_calls && m.tool_calls.length" class="ai-tools">
              <summary>已查询 {{ m.tool_calls.length }} 项数据</summary>
              <div v-for="(t, ti) in m.tool_calls" :key="ti" class="ai-tool-row">
                <div class="ai-tool-name">
                  {{ t.name }}
                  <span v-if="t.ok === false" style="color:#f56c6c">（失败）</span>
                </div>
                <div class="ai-tool-meta">{{ t.ms }}ms · {{ t.row_count }} 行</div>
                <div class="ai-tool-args">{{ JSON.stringify(t.args) }}</div>
              </div>
            </details>
          </div>
        </div>

        <div v-if="sending" class="ai-msg assistant">
          <div class="ai-bubble ai-loading">正在查询数据…</div>
        </div>
        <el-alert
          v-if="error"
          type="error"
          :title="error"
          :closable="false"
          style="margin-top:8px"
        />
      </div>

      <div class="ai-input">
        <el-input
          v-model="input"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 4 }"
          resize="none"
          :disabled="!canUse"
          :placeholder="canUse ? '问库存、价值、低库存、毛利…（Enter 发送，Shift+Enter 换行）' : (!enabled ? 'AI 已关闭' : (localOnly ? '请先设置访问密码' : '请先配置 API Key'))"
          @keydown.enter.exact.prevent="onEnter"
          @compositionstart="composing = true"
          @compositionend="composing = false"
        />
        <el-button type="primary" :loading="sending" :disabled="!canUse || !input.trim()" @click="send()">
          发送
        </el-button>
      </div>
      <div class="ai-footer">数字来自本机账本；如文字与数据卡片不一致，以数据卡片为准。</div>
    </div>
  </el-drawer>
  <AiPermissionDialog
    v-model="permissionOpen"
    :status="aiStatus || {}"
    :permission="aiPermission"
    @changed="onPermissionChanged"
  />
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import AiDataCard from './AiDataCard.vue';
import AiActionCard from './AiActionCard.vue';
import AiPermissionDialog from './AiPermissionDialog.vue';
import { errorText } from '../ui';
import {
  aiOpen, aiStatus, aiMessages, aiSending, aiError, aiPermission,
  openAi, closeAi, sendAiMessage, clearAiHistory, loadAiStatus,
  confirmAiAction, cancelAiAction, lockAiPermission, saveAiHistory
} from '../ai/useAi';

const router = useRouter();
const props = defineProps({ mobile: { type: Boolean, default: false } });
const input = ref('');
const composing = ref(false);
const messagesRef = ref(null);
const permissionOpen = ref(false);
const workingAction = ref('');
const now = ref(Date.now());
let clock = null;

const messages = aiMessages;
const sending = aiSending;
const error = aiError;
const configured = computed(() => aiStatus.value?.configured !== false);
const enabled = computed(() => aiStatus.value?.enabled !== false);
const localOnly = computed(() => aiStatus.value?.local_only === true);
const isWrite = computed(() => aiPermission.value?.level === 'write');
const isDanger = computed(() => aiPermission.value?.level === 'danger');
const isWriteLike = computed(() => isWrite.value || isDanger.value);
const remainingText = computed(() => {
  if (!isWriteLike.value || !aiPermission.value?.expires_at) return '';
  const left = Math.max(0, Math.ceil((new Date(aiPermission.value.expires_at).getTime() - now.value) / 1000));
  return `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
});
const canUse = computed(() => configured.value && enabled.value && !localOnly.value);

const suggestions = [
  '主仓库现在有多少库存？值多少钱？',
  '哪些香料快没货了？',
  '哪些货压着卖不动？',
  '花椒最近进价有什么变化？',
  '这个月每天卖了多少？',
  '本月毛利是多少？'
];

function open() { openAi(); }
function close() { closeAi(); }

async function send(text) {
  const q = text !== undefined ? text : input.value;
  if (!q || !String(q).trim() || sending.value) return;
  input.value = '';
  await sendAiMessage(q);
  scrollToBottom();
}
function onEnter() {
  if (composing.value) return;
  send();
}
function scrollToBottom() {
  nextTick(() => {
    const el = messagesRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}
function clear() {
  clearAiHistory();
  ElMessage.success('对话已清空');
}
function goSettings() {
  close();
  router.push({ path: '/settings', query: { tab: 'ai' } });
}

async function lockNow() {
  try {
    await lockAiPermission();
    ElMessage.success('已锁定，AI 回到只读');
  } catch (e) {
    ElMessage.error(errorText(e, '锁定失败'));
  }
}
function onPermissionChanged() {
  // 权限组件已经更新了 aiPermission；这里只负责滚动和提示。
  scrollToBottom();
}

async function onConfirmAction(action) {
  if (!action || workingAction.value) return;
  workingAction.value = action.action_id;
  action.error = '';
  try {
    const r = await confirmAiAction(action);
    action.status = 'confirmed';
    action.result = r.result || null;
    action.backup = r.backup || '';
    ElMessage.success(r.result?.order_no ? `已执行：${r.result.order_no}` : '已执行');
  } catch (e) {
    action.error = errorText(e, '执行失败');
    const code = e?.response?.data?.code;
    if (code === 'STALE_ACTION' || code === 'ACTION_STATE') action.status = 'expired';
    else if (code === 'VALIDATION_FAILED' || code === 'ACTION_FAILED') action.status = 'failed';
    ElMessage.error(action.error);
  } finally {
    workingAction.value = '';
    saveAiHistory();
    scrollToBottom();
  }
}

async function onCancelAction(action) {
  if (!action || workingAction.value) return;
  workingAction.value = action.action_id;
  action.error = '';
  try {
    await cancelAiAction(action);
    action.status = 'cancelled';
    ElMessage.success('已取消，不会写入');
  } catch (e) {
    action.error = errorText(e, '取消失败');
    ElMessage.error(action.error);
  } finally {
    workingAction.value = '';
    saveAiHistory();
    scrollToBottom();
  }
}

watch(messages, scrollToBottom, { deep: true });
watch(sending, scrollToBottom);

onMounted(() => {
  loadAiStatus().catch(() => {});
  scrollToBottom();
  clock = setInterval(() => {
    now.value = Date.now();
    if (['write', 'danger'].includes(aiPermission.value?.level) && aiPermission.value?.expires_at
      && new Date(aiPermission.value.expires_at).getTime() <= now.value) {
      aiPermission.value = { level: 'read', expires_at: null };
    }
  }, 1000);
});
onUnmounted(() => { if (clock) clearInterval(clock); });
</script>

<style scoped>
.ai-fab {
  position: fixed;
  right: 26px;
  bottom: 26px;
  z-index: 2000;
  width: 52px;
  height: 52px;
  box-shadow: 0 8px 24px rgba(64, 158, 255, .35);
}
.ai-drawer :deep(.el-drawer__body) { padding: 0; }
.ai-write-bar { height: 3px; background: linear-gradient(90deg, #e6a23c, #f56c6c); }
.ai-write-bar.is-danger { background: linear-gradient(90deg, #f56c6c, #c45656); }
.ai-shell { height: 100%; display: flex; flex-direction: column; background: #f5f7fa; }
.ai-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; background: #fff; border-bottom: 1px solid #e5e7eb; }
.ai-title { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 15px; }
.ai-header-right { display: flex; align-items: center; gap: 8px; }
.ai-notice { padding: 10px 14px 0; display: flex; flex-direction: column; gap: 8px; }
.ai-messages { flex: 1; overflow-y: auto; padding: 12px 14px; }
.ai-empty { color: #606266; font-size: 13px; line-height: 1.7; padding-top: 24px; }
.ai-empty-title { font-weight: 600; color: #303133; margin-bottom: 10px; }
.ai-suggestions { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.ai-empty-tip { color: #909399; font-size: 12px; margin-top: 14px; }
.ai-msg { display: flex; margin-bottom: 10px; }
.ai-msg.user { justify-content: flex-end; }
.ai-msg.assistant { justify-content: flex-start; }
.ai-bubble { max-width: 92%; border-radius: 10px; padding: 9px 11px; font-size: 13px; line-height: 1.65; background: #fff; border: 1px solid #e5e7eb; }
.ai-msg.user .ai-bubble { background: #409eff; border-color: #409eff; color: #fff; }
.ai-text { white-space: pre-wrap; word-break: break-word; }
.ai-loading { color: #909399; }
.ai-tools { margin-top: 8px; border-top: 1px dashed #e5e7eb; padding-top: 6px; font-size: 12px; color: #909399; }
.ai-tools summary { cursor: pointer; user-select: none; }
.ai-tool-row { padding: 5px 0; border-bottom: 1px solid #f0f2f5; }
.ai-tool-row:last-child { border-bottom: none; }
.ai-tool-name { color: #606266; font-weight: 600; }
.ai-tool-meta { color: #909399; }
.ai-tool-args { color: #a8abb2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-input { display: flex; gap: 8px; align-items: flex-end; padding: 10px 14px; background: #fff; border-top: 1px solid #e5e7eb; }
.ai-input .el-textarea { flex: 1; }
.ai-footer { font-size: 11px; color: #a8abb2; text-align: center; padding: 0 14px 10px; background: #fff; }
.ai-shell.is-mobile .ai-header { padding-top: calc(12px + env(safe-area-inset-top, 0px)); }
.ai-shell.is-mobile .ai-footer { padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)); }
</style>