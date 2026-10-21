import { ref } from 'vue';
import api from '../api';

const SESSION_KEY = 'ls_ai_session';
const HISTORY_KEY = 'ls_ai_history_v1';
const MAX_HISTORY = 16;
const READ_PERMISSION = { level: 'read', expires_at: null };

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.slice(-MAX_HISTORY) : [];
  } catch {
    return [];
  }
}
function saveHistory() {
  try {
    // 卡片里的表格可能很长；本地只留最近 16 条、每张表最多 30 行，
    // 避免 localStorage 被明细撑爆。服务端审计不受影响。
    const compact = aiMessages.value.slice(-MAX_HISTORY).map(m => ({
      ...m,
      cards: (m.cards || []).slice(0, 4).map(c => c?.type === 'table'
        ? { ...c, rows: (c.rows || []).slice(0, 30) }
        : c),
      actions: (m.actions || []).slice(0, 3).map(a => a.status === 'proposed'
        ? a
        : { ...a, confirm_token: undefined })
    }));
    localStorage.setItem(HISTORY_KEY, JSON.stringify(compact));
  } catch { /* 隐私模式/超额时忽略 */ }
}
function setSession(id) {
  aiSession.value = id || '';
  try {
    if (id) localStorage.setItem(SESSION_KEY, id);
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* ignore */ }
}
function cachedSession() {
  try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
}

export const aiOpen = ref(false);
export const aiStatus = ref(null);
export const aiSession = ref('');
export const aiMessages = ref(loadHistory());
export const aiSending = ref(false);
export const aiError = ref('');
export const aiPermission = ref({ ...READ_PERMISSION });

async function ensureSession() {
  if (aiSession.value) return aiSession.value;
  const cached = cachedSession();
  if (cached) { aiSession.value = cached; return cached; }
  const s = await api.post('/ai/session');
  setSession(s.session_id);
  if (s.permission) aiPermission.value = s.permission;
  markProposedActionsCancelled();
  return s.session_id;
}

export async function loadAiStatus() {
  const sid = aiSession.value || cachedSession();
  const status = await api.get('/ai/status', { params: sid ? { session_id: sid } : {} });
  aiStatus.value = status;
  if (status.permission) aiPermission.value = status.permission;
  if (sid && status.session_valid === false) {
    setSession('');
    aiPermission.value = { ...READ_PERMISSION };
    markProposedActionsCancelled();
  }
  return status;
}

async function callChat(sessionId) {
  return api.post('/ai/chat', {
    session_id: sessionId,
    messages: aiMessages.value.slice(-12).map(m => ({ role: m.role, content: m.content }))
  });
}

async function postWithSession(path, body = {}) {
  let sid = await ensureSession();
  try {
    return await api.post(path, { ...body, session_id: sid });
  } catch (e) {
    if (e?.response?.data?.code === 'NO_SESSION') {
      setSession('');
      aiPermission.value = { ...READ_PERMISSION };
      sid = await ensureSession();
      return api.post(path, { ...body, session_id: sid });
    }
    throw e;
  }
}

export async function sendAiMessage(text) {
  const content = String(text || '').trim();
  if (!content || aiSending.value) return;
  aiError.value = '';
  aiMessages.value.push({ role: 'user', content });
  saveHistory();
  aiSending.value = true;
  try {
    let sid = await ensureSession();
    let res;
    try {
      res = await callChat(sid);
    } catch (e) {
      // 会话过期：换一个新会话重试一次
      if (e?.response?.data?.code === 'NO_SESSION') {
        setSession('');
        aiPermission.value = { ...READ_PERMISSION };
        sid = await ensureSession();
        res = await callChat(sid);
      } else {
        throw e;
      }
    }
    if (res.permission) aiPermission.value = res.permission;
    aiMessages.value.push({
      role: 'assistant',
      content: res.reply || '',
      cards: res.cards || [],
      actions: res.actions || [],
      tool_calls: res.tool_calls || []
    });
    saveHistory();
  } catch (e) {
    aiError.value = e?.response?.data?.error || e.message || 'AI 调用失败，请稍后重试';
  } finally {
    aiSending.value = false;
  }
}

function markProposedActionsCancelled() {
  let changed = false;
  for (const m of aiMessages.value) {
    for (const a of (m.actions || [])) {
      if (a.status === 'proposed') { a.status = 'cancelled'; changed = true; }
    }
  }
  if (changed) saveHistory();
}

export async function grantAiPermission({ level = 'write', minutes = 15, password = '', confirm_text = '' } = {}) {
  const r = await postWithSession('/ai/permission', { level, minutes, password, confirm_text });
  if (r.permission) aiPermission.value = r.permission;
  markProposedActionsCancelled();
  return r;
}

export async function lockAiPermission() {
  const r = await postWithSession('/ai/permission', { level: 'read' });
  aiPermission.value = r.permission || { ...READ_PERMISSION };
  markProposedActionsCancelled();
  return r;
}

export async function confirmAiAction(action) {
  return postWithSession(`/ai/actions/${encodeURIComponent(action.action_id)}/confirm`, {
    confirm_token: action.confirm_token
  });
}

export async function cancelAiAction(action) {
  return postWithSession(`/ai/actions/${encodeURIComponent(action.action_id)}/cancel`, {
    confirm_token: action.confirm_token
  });
}

export function saveAiHistory() {
  saveHistory();
}

export function clearAiHistory() {
  aiMessages.value = [];
  aiError.value = '';
  saveHistory();
}

export function openAi() {
  aiOpen.value = true;
  loadAiStatus().catch(() => {});
}
export function closeAi() {
  aiOpen.value = false;
}