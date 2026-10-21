import crypto from 'node:crypto';

// v1 是单机单用户：AI 会话只区分“谁在问”和“能不能写”。
// 这里保留 actor / permission 结构，未来接账号体系时只需要替换 actor，
// 不需要改 agent、工具或审计。
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PENDING_TTL_MS = 5 * 60 * 1000;
const sessions = new Map();
const pendingActions = new Map();

function newId(prefix) {
  return prefix + crypto.randomBytes(12).toString('hex');
}

function localActor() {
  return {
    id: 1,
    type: 'local',
    role: 'owner',
    auth_method: 'access_password',
    name: '本机用户'
  };
}

export function createSession() {
  const id = newId('ai_');
  const now = Date.now();
  const session = {
    id,
    actor: localActor(),
    permission: { level: 'read', expires_at: null },
    created_at: now,
    last_seen: now,
    expires_at: now + SESSION_TTL_MS,
    write_backup: null
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id) {
  const session = sessions.get(String(id || ''));
  if (!session) return null;
  const now = Date.now();
  if (session.expires_at < now) {
    sessions.delete(session.id);
    return null;
  }
  session.last_seen = now;
  return session;
}

export function getPermission(session) {
  if (!session) return { level: 'read', expires_at: null };
  if (session.permission.level !== 'read' && session.permission.expires_at && session.permission.expires_at < Date.now()) {
    session.permission = { level: 'read', expires_at: null };
  }
  return session.permission;
}

function invalidatePendingForSession(sessionId) {
  for (const rec of pendingActions.values()) {
    if (rec.sessionId === sessionId && rec.status === 'proposed') rec.status = 'cancelled';
  }
}

// level: read / write / danger。
// danger（作废/改单）5 分钟，需要访问密码 + 用户手动输入确认词，由路由层校验。
export function setPermission(session, level, minutes) {
  if (!session) throw new Error('AI 会话不存在或已过期');
  if (level === 'read') {
    invalidatePendingForSession(session.id);
    session.permission = { level: 'read', expires_at: null };
    return session.permission;
  }
  if (level !== 'write' && level !== 'danger') {
    const err = new Error('未知的权限级别');
    err.code = 'INVALID_PERMISSION';
    throw err;
  }
  const defMins = level === 'danger' ? 5 : 15;
  const maxMins = level === 'danger' ? 15 : 60;
  const mins = Math.min(Math.max(Number(minutes) || defMins, 1), maxMins);
  // 新一轮授权从干净状态开始：之前没确认的提案全部作废。
  invalidatePendingForSession(session.id);
  session.permission = { level, expires_at: Date.now() + mins * 60_000 };
  session.write_backup = null;   // 新一轮授权，第一次写前重新备份
  return session.permission;
}

export function lockSession(session) {
  if (!session) return;
  invalidatePendingForSession(session.id);
  session.permission = { level: 'read', expires_at: null };
}

export function sessionView(session) {
  if (!session) return null;
  return {
    session_id: session.id,
    actor: session.actor,
    permission: getPermission(session),
    expires_at: new Date(session.expires_at).toISOString()
  };
}

// ---------- 待确认写操作 ----------

export function createPendingAction(session, action) {
  if (!session) throw new Error('AI 会话不存在或已过期');
  const id = newId('act_');
  const token = newId('cf_');
  const expiresAt = Date.now() + PENDING_TTL_MS;
  pendingActions.set(id, {
    id,
    token,
    sessionId: session.id,
    action,
    status: 'proposed',
    createdAt: Date.now(),
    expiresAt
  });
  return {
    action_id: id,
    confirm_token: token,
    expires_at: new Date(expiresAt).toISOString()
  };
}

export function getPendingAction(id) {
  const rec = pendingActions.get(String(id || ''));
  if (!rec) return null;
  if (rec.status === 'proposed' && rec.expiresAt < Date.now()) rec.status = 'expired';
  return rec;
}

export function confirmPendingAction(id, sessionId, token) {
  const rec = getPendingAction(id);
  if (!rec) return { error: '待确认操作不存在', code: 'ACTION_NOT_FOUND' };
  if (rec.sessionId !== sessionId) return { error: '这个操作不属于当前会话', code: 'ACTION_FORBIDDEN' };
  if (rec.token !== token) return { error: '确认令牌不正确', code: 'ACTION_FORBIDDEN' };
  if (rec.status !== 'proposed') return { error: `操作状态已是 ${rec.status}，不能重复执行`, code: 'ACTION_STATE' };
  rec.status = 'confirmed';
  rec.confirmedAt = Date.now();
  return { record: rec };
}

export function cancelPendingAction(id, sessionId, token) {
  const rec = getPendingAction(id);
  if (!rec) return { error: '待确认操作不存在', code: 'ACTION_NOT_FOUND' };
  if (rec.sessionId !== sessionId) return { error: '这个操作不属于当前会话', code: 'ACTION_FORBIDDEN' };
  if (rec.token !== token) return { error: '确认令牌不正确', code: 'ACTION_FORBIDDEN' };
  if (rec.status !== 'proposed') return { error: `操作状态已是 ${rec.status}，不能取消`, code: 'ACTION_STATE' };
  rec.status = 'cancelled';
  rec.cancelledAt = Date.now();
  return { record: rec };
}

export function markPendingAction(id, status) {
  const rec = pendingActions.get(String(id || ''));
  if (rec) rec.status = status;
  return rec;
}

export function cleanupSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expires_at < now || s.last_seen + 24 * 60 * 60 * 1000 < now) sessions.delete(id);
  }
  for (const [id, rec] of pendingActions) {
    if (rec.expiresAt + 60 * 60 * 1000 < now) pendingActions.delete(id);
  }
}