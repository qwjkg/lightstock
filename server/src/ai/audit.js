import { db } from '../db.js';

function truncate(text, max = 800) {
  const s = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// 记录一次 AI 调用。写失败不应该影响主流程，所以调用方可以忽略异常。
export function logAiAudit(entry = {}) {
  try {
    db.prepare(`INSERT INTO ai_audit_log
      (session_id, user_id, actor_type, auth_method, role, kind, tool_name, args_json,
       result_summary, permission_level, action_id, action_status, ref_type, ref_id, ref_no,
       model, prompt_tokens, completion_tokens, duration_ms, error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      String(entry.session_id || ''),
      entry.user_id ?? null,
      entry.actor_type || 'local',
      entry.auth_method || '',
      entry.role || 'owner',
      String(entry.kind || 'chat'),
      String(entry.tool_name || ''),
      truncate(entry.args_json || ''),
      truncate(entry.result_summary || ''),
      entry.permission_level || 'read',
      String(entry.action_id || ''),
      String(entry.action_status || ''),
      String(entry.ref_type || ''),
      entry.ref_id ?? null,
      String(entry.ref_no || ''),
      String(entry.model || ''),
      Number(entry.prompt_tokens) || 0,
      Number(entry.completion_tokens) || 0,
      Number(entry.duration_ms) || 0,
      truncate(entry.error || '')
    );
    return true;
  } catch {
    return false;
  }
}

export function listAiAudit({ limit = 100, kind = '', sessionId = '' } = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return db.prepare(`
    SELECT * FROM ai_audit_log
    WHERE (?='' OR kind=?) AND (?='' OR session_id=?)
    ORDER BY id DESC LIMIT ?`).all(kind, kind, sessionId, sessionId, n);
}