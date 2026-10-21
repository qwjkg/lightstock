import { Router } from 'express';
import { db, getSetting, setSetting } from '../db.js';
import { getAiConfig, saveApiKey, clearApiKey, chatWithTools, scrubSecret } from '../ai/provider.js';
import {
  createSession, getSession, sessionView, setPermission, lockSession, cleanupSessions,
  getPermission, getPendingAction, cancelPendingAction, markPendingAction
} from '../ai/permissions.js';
import { runAgent } from '../ai/agent.js';
import { listAiAudit, logAiAudit } from '../ai/audit.js';
import { validateAction } from '../ai/tools.js';
import { executeAction } from '../ai/actions.js';
import { createBackupFile } from './system.js';

const router = Router();

const DANGER_CONFIRM_TEXT = '确认高风险';

function isLoopback(req) {
  const ip = String(req.socket?.remoteAddress || req.ip || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function statusPayload() {
  const cfg = getAiConfig();
  return {
    ok: true,
    enabled: cfg.enabled,
    configured: cfg.configured,
    provider: getSetting('ai_provider', 'deepseek'),
    model: cfg.model,
    base_url: cfg.baseURL,
    key_source: cfg.key_source,
    key_hint: cfg.key_hint,
    privacy: getSetting('ai_privacy', 'business'),
    daily_token_budget: Number(getSetting('ai_daily_token_budget', '200000')) || 0,
    password_required: !!getSetting('access_password', ''),
    permission: { level: 'read', expires_at: null }
  };
}

// 未设置访问密码时，AI 只允许本机使用：
// 否则同局域网的任何人都能用店主的 API Key 提问、消耗额度。
// 设置了访问密码后，外层 /api 鉴权已经拦过一次，这里直接放行。
function requireLocalOrPassword(req, res, next) {
  if (getSetting('access_password', '')) return next();
  if (isLoopback(req)) return next();
  return res.status(403).json({
    ok: false,
    error: '未设置访问密码时，AI 助手仅限本机使用。请先在设置中设置访问密码，再从手机/局域网使用。',
    code: 'LOCAL_ONLY'
  });
}

router.get('/ai/status', (req, res) => {
  cleanupSessions();
  const sid = String(req.query.session_id || '');
  const session = sid ? getSession(sid) : null;
  res.json({
    ...statusPayload(),
    permission: session ? getPermission(session) : { level: 'read', expires_at: null },
    actor: session?.actor || null,
    session_valid: sid ? !!session : undefined,
    // 前端据此提示：未设访问密码时，手机/局域网不能使用 AI。
    local_only: !getSetting('access_password', '') && !isLoopback(req)
  });
});

router.post('/ai/session', requireLocalOrPassword, (req, res) => {
  cleanupSessions();
  const session = createSession();
  res.json({ ok: true, ...sessionView(session) });
});

router.post('/ai/permission', requireLocalOrPassword, (req, res) => {
  const session = getSession(req.body?.session_id);
  if (!session) return res.status(409).json({ ok: false, error: 'AI 会话不存在或已过期，请刷新页面重试', code: 'NO_SESSION' });

  const level = ['read', 'write', 'danger'].includes(req.body?.level) ? req.body.level : 'read';
  if (level === 'read') {
    lockSession(session);
    return res.json({ ok: true, ...sessionView(session) });
  }

  const pw = getSetting('access_password', '');
  try {
    if (level === 'danger') {
      // 高风险操作必须已有访问密码；即使在本机也不放行无密码授权。
      if (!pw) {
        return res.status(403).json({ ok: false, error: '请先在设置中设置访问密码，再开启高风险权限', code: 'PASSWORD_REQUIRED' });
      }
      if (String(req.body?.password || '') !== pw) {
        return res.status(403).json({ ok: false, error: '高风险授权需要输入访问密码', code: 'PASSWORD_REQUIRED' });
      }
      if (String(req.body?.confirm_text || '') !== DANGER_CONFIRM_TEXT) {
        return res.status(400).json({ ok: false, error: `请输入确认词「${DANGER_CONFIRM_TEXT}」`, code: 'CONFIRM_TEXT_REQUIRED' });
      }
      const permission = setPermission(session, 'danger', req.body?.minutes || 5);
      return res.json({ ok: true, ...sessionView(session), permission });
    }

    if (pw && String(req.body?.password || '') !== pw) {
      return res.status(403).json({ ok: false, error: '需要输入访问密码才能授权 AI 记账', code: 'PASSWORD_REQUIRED' });
    }
    const permission = setPermission(session, 'write', req.body?.minutes || 15);
    res.json({ ok: true, ...sessionView(session), permission });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code || 'PERMISSION_ERROR' });
  }
});

const busy = new Set();
const rate = new Map();

function rateLimited(sessionId) {
  const now = Date.now();
  const r = rate.get(sessionId) || { count: 0, reset: now + 60_000 };
  if (now > r.reset) { r.count = 0; r.reset = now + 60_000; }
  r.count++;
  rate.set(sessionId, r);
  return r.count > 20;
}

function dailyTokensUsed() {
  return db.prepare(`SELECT COALESCE(SUM(prompt_tokens + completion_tokens),0) AS c
    FROM ai_audit_log WHERE kind='chat' AND date(created_at)=date('now','localtime')`).get().c;
}

function actionNeedsDanger(type) {
  return type === 'void_order' || type === 'update_order';
}
function canConfirmWith(level, type) {
  return actionNeedsDanger(type) ? level === 'danger' : (level === 'write' || level === 'danger');
}

router.post('/ai/chat', requireLocalOrPassword, async (req, res) => {
  const session = getSession(req.body?.session_id);
  if (!session) return res.status(409).json({ ok: false, error: 'AI 会话不存在或已过期，请刷新页面重试', code: 'NO_SESSION' });
  if (busy.has(session.id)) return res.status(429).json({ ok: false, error: '上一个问题还在处理中，请稍等', code: 'BUSY' });
  if (rateLimited(session.id)) return res.status(429).json({ ok: false, error: '问得太快了，请稍后再试', code: 'RATE_LIMIT' });
  const budget = Number(getSetting('ai_daily_token_budget', '200000')) || 0;
  if (budget > 0 && dailyTokensUsed() >= budget) {
    return res.status(429).json({
      ok: false,
      error: `今日 AI 用量已达到上限（${budget} tokens），可在 设置 → AI 助手 调高或明天再试`,
      code: 'BUDGET_EXCEEDED'
    });
  }

  const messages = req.body?.messages;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ ok: false, error: '缺少消息内容', code: 'INVALID_MESSAGES' });
  }

  busy.add(session.id);
  try {
    const result = await runAgent({ session, messages });
    res.json({ ok: true, ...result });
  } catch (e) {
    const code = e.code || 'AI_ERROR';
    const status = code === 'AI_NOT_CONFIGURED' || code === 'AI_DISABLED' ? 503
      : code === 'INVALID_MESSAGES' ? 400
      : 502;
    res.status(status).json({ ok: false, error: scrubSecret(e.message || 'AI 调用失败'), code });
  } finally {
    busy.delete(session.id);
  }
});

router.post('/ai/actions/:id/confirm', requireLocalOrPassword, async (req, res) => {
  const session = getSession(req.body?.session_id);
  if (!session) return res.status(409).json({ ok: false, error: 'AI 会话不存在或已过期，请刷新页面重试', code: 'NO_SESSION' });

  const rec = getPendingAction(req.params.id);
  if (!rec) return res.status(404).json({ ok: false, error: '待确认操作不存在', code: 'ACTION_NOT_FOUND' });
  const permission = getPermission(session);
  if (!canConfirmWith(permission.level, rec.action?.type)) {
    return res.status(403).json({
      ok: false,
      error: actionNeedsDanger(rec.action?.type) ? '高风险权限已失效，请重新授权后再确认' : '写权限已失效，请重新授权后再确认',
      code: 'PERMISSION_REQUIRED'
    });
  }
  if (rec.sessionId !== session.id) return res.status(403).json({ ok: false, error: '这个操作不属于当前会话', code: 'ACTION_FORBIDDEN' });
  if (rec.token !== String(req.body?.confirm_token || '')) return res.status(403).json({ ok: false, error: '确认令牌不正确', code: 'ACTION_FORBIDDEN' });
  if (rec.status !== 'proposed') {
    return res.status(410).json({ ok: false, error: `操作已${rec.status === 'expired' ? '过期' : '处理'}，请让 AI 重新生成提案`, code: 'ACTION_STATE' });
  }
  // 先占位，防止两个并发确认把同一张单执行两次。
  markPendingAction(rec.id, 'confirming');

  // 重新校验：商品/单位/库存/价格可能已经变化，不能拿旧预览直接执行。
  const check = validateAction(rec.action);
  if (!check.ok) {
    markPendingAction(rec.id, 'failed');
    logAiAudit({
      session_id: session.id, user_id: session.actor?.id, actor_type: session.actor?.type,
      auth_method: session.actor?.auth_method, role: session.actor?.role,
      kind: 'action', tool_name: '', args_json: rec.action?.args || {},
      result_summary: rec.action?.type || '', permission_level: permission.level,
      action_id: rec.id, action_status: 'failed',
      error: check.error || '校验失败'
    });
    return res.status(409).json({ ok: false, error: check.error || '操作校验失败', code: check.code || 'VALIDATION_FAILED' });
  }
  if (JSON.stringify(check.preview) !== JSON.stringify(rec.action.preview)) {
    markPendingAction(rec.id, 'expired');
    logAiAudit({
      session_id: session.id, user_id: session.actor?.id, actor_type: session.actor?.type,
      auth_method: session.actor?.auth_method, role: session.actor?.role,
      kind: 'action', tool_name: '', args_json: rec.action?.args || {},
      result_summary: rec.action?.type || '', permission_level: permission.level,
      action_id: rec.id, action_status: 'failed',
      error: '数据在确认前发生变化'
    });
    return res.status(409).json({
      ok: false,
      error: '库存或商品数据在确认前发生了变化，请让 AI 重新生成提案再确认',
      code: 'STALE_ACTION'
    });
  }

  // 每个“可记账”会话第一次写入前备份一次；备份失败不执行。
  if (!session.write_backup) {
    try {
      session.write_backup = await createBackupFile();
    } catch (e) {
      logAiAudit({
        session_id: session.id, user_id: session.actor?.id, actor_type: session.actor?.type,
        auth_method: session.actor?.auth_method, role: session.actor?.role,
        kind: 'action', args_json: rec.action?.args || {},
        result_summary: rec.action?.type || '', permission_level: permission.level,
        action_id: rec.id, action_status: 'failed',
        error: '备份失败：' + e.message
      });
      markPendingAction(rec.id, 'proposed');
      return res.status(500).json({ ok: false, error: '写入前备份失败，已阻止执行：' + e.message, code: 'BACKUP_FAILED' });
    }
  }

  // 备份是异步的；备份期间可能有别的单据改动库存，执行前再校验一次。
  const finalCheck = validateAction(rec.action);
  if (!finalCheck.ok || JSON.stringify(finalCheck.preview) !== JSON.stringify(rec.action.preview)) {
    markPendingAction(rec.id, 'expired');
    return res.status(409).json({
      ok: false,
      error: '备份期间库存或商品数据发生了变化，请让 AI 重新生成提案再确认',
      code: 'STALE_ACTION'
    });
  }
  if (!canConfirmWith(getPermission(session).level, rec.action?.type)) {
    markPendingAction(rec.id, 'proposed');
    return res.status(403).json({
      ok: false,
      error: actionNeedsDanger(rec.action?.type) ? '高风险权限已失效，请重新授权后再确认' : '写权限已失效，请重新授权后再确认',
      code: 'PERMISSION_REQUIRED'
    });
  }

  try {
    const exec = executeAction(rec, finalCheck.resolved);
    markPendingAction(rec.id, 'confirmed');
    logAiAudit({
      session_id: session.id, user_id: session.actor?.id, actor_type: session.actor?.type,
      auth_method: session.actor?.auth_method, role: session.actor?.role,
      kind: 'action', args_json: rec.action?.args || {},
      result_summary: exec.ref_no || '库存已调整', permission_level: permission.level,
      action_id: rec.id, action_status: 'confirmed',
      ref_type: exec.ref_type, ref_id: exec.ref_id, ref_no: exec.ref_no
    });
    res.json({
      ok: true,
      action_id: rec.id,
      result: exec.result,
      backup: session.write_backup ? String(session.write_backup).split(/[\\/]/).pop() : ''
    });
  } catch (e) {
    markPendingAction(rec.id, 'failed');
    logAiAudit({
      session_id: session.id, user_id: session.actor?.id, actor_type: session.actor?.type,
      auth_method: session.actor?.auth_method, role: session.actor?.role,
      kind: 'action', args_json: rec.action?.args || {},
      result_summary: rec.action?.type || '', permission_level: permission.level,
      action_id: rec.id, action_status: 'failed',
      error: scrubSecret(e.message)
    });
    res.status(400).json({ ok: false, error: scrubSecret(e.message || '执行失败'), code: 'ACTION_FAILED' });
  }
});

router.post('/ai/actions/:id/cancel', requireLocalOrPassword, (req, res) => {
  const session = getSession(req.body?.session_id);
  if (!session) return res.status(409).json({ ok: false, error: 'AI 会话不存在或已过期，请刷新页面重试', code: 'NO_SESSION' });
  const rec = getPendingAction(req.params.id);
  if (!rec) return res.status(404).json({ ok: false, error: '待确认操作不存在', code: 'ACTION_NOT_FOUND' });
  const out = cancelPendingAction(rec.id, session.id, String(req.body?.confirm_token || ''));
  if (out.error) return res.status(409).json({ ok: false, error: out.error, code: out.code });
  logAiAudit({
    session_id: session.id, user_id: session.actor?.id, actor_type: session.actor?.type,
    auth_method: session.actor?.auth_method, role: session.actor?.role,
    kind: 'action', args_json: rec.action?.args || {},
    result_summary: rec.action?.type || '', permission_level: getPermission(session).level,
    action_id: rec.id, action_status: 'cancelled'
  });
  res.json({ ok: true, action_id: rec.id, status: 'cancelled' });
});

router.get('/ai/audit', (req, res) => {
  const rows = listAiAudit({
    limit: req.query.limit,
    kind: req.query.kind || '',
    sessionId: req.query.session_id || ''
  });
  res.json(rows);
});

router.get('/ai/health', (req, res) => {
  const cfg = getAiConfig();
  res.json({
    ok: true,
    configured: cfg.configured,
    enabled: cfg.enabled,
    model: cfg.model,
    base_url: cfg.baseURL,
    key_source: cfg.key_source
  });
});

router.post('/ai/test', requireLocalOrPassword, async (req, res) => {
  try {
    const cfg = getAiConfig();
    if (!cfg.configured) return res.status(503).json({ ok: false, error: '还没有配置 API Key', code: 'AI_NOT_CONFIGURED' });
    const out = await chatWithTools({
      messages: [
        { role: 'system', content: '只回复两个字：正常' },
        { role: 'user', content: '连通性测试' }
      ],
      tools: [],
      temperature: 0,
      maxTokens: 8
    });
    res.json({ ok: true, model: out.model, reply: out.message?.content || '', ms: out.duration_ms });
  } catch (e) {
    res.status(502).json({ ok: false, error: scrubSecret(e.message), code: e.code || 'AI_ERROR' });
  }
});

router.put('/ai/config', requireLocalOrPassword, (req, res) => {
  const b = req.body || {};
  if (b.enabled !== undefined) setSetting('ai_enabled', b.enabled ? '1' : '0');
  if (b.model !== undefined) {
    const model = String(b.model).trim();
    if (model.length > 100) return res.status(400).json({ ok: false, error: '模型名过长' });
    setSetting('ai_model', model);
  }
  if (b.base_url !== undefined) {
    const url = String(b.base_url).trim();
    if (url && !/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url)) {
      return res.status(400).json({ ok: false, error: 'Base URL 必须是 https，或本机 http 地址' });
    }
    setSetting('ai_base_url', url);
  }
  if (b.privacy !== undefined) {
    // P0 只实现 business：工具不会返回联系方式，但也不会隐藏商品/往来单位名。
    // aggregate / full 留到 P1 再开放，避免设置项看起来可用、实际没生效。
    if (b.privacy !== 'business') {
      return res.status(400).json({ ok: false, error: '当前版本仅支持「业务明细」隐私级别，aggregate/full 将在下一阶段开放' });
    }
    setSetting('ai_privacy', 'business');
  }
  if (b.daily_token_budget !== undefined) {
    const n = Number(b.daily_token_budget);
    if (!Number.isFinite(n) || n < 0 || n > 100000000) {
      return res.status(400).json({ ok: false, error: '每日 token 上限不合法' });
    }
    setSetting('ai_daily_token_budget', Math.floor(n));
  }
  res.json(statusPayload());
});

router.put('/ai/key', (req, res) => {
  const accessPassword = getSetting('access_password', '');
  if (accessPassword) {
    if (String(req.body?.password || '') !== accessPassword) {
      return res.status(403).json({ ok: false, error: '需要验证访问密码才能修改 API Key', code: 'PASSWORD_REQUIRED' });
    }
  } else if (!isLoopback(req)) {
    return res.status(403).json({ ok: false, error: '未设置访问密码时，只能在这台电脑上修改 API Key', code: 'LOCAL_ONLY' });
  }

  try {
    const key = String(req.body?.key || '').trim();
    if (key) saveApiKey(key);
    else clearApiKey();
    res.json({ ok: true, ...statusPayload() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

export default router;